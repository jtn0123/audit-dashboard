const express = require('express');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { Collector } = require('./lib/collector');
const { buildDigest } = require('./lib/digest');
const { spec: openapiSpec } = require('./lib/openapi');
const { GitHubClient } = require('./lib/github');
const { settingsFileFor, loadSettings, saveSettings, tokenTail, looksLikeGitHubToken } = require('./lib/settings');

const app = express();
const PORT = process.env.PORT || 3000;

const pkg = require('./package.json');

const ghConfig = loadConfig();
// A token saved through the settings page outranks the env var; clearing it
// falls back to whatever the environment provided at boot.
const ENV_TOKEN = ghConfig.token;
const SETTINGS_FILE = settingsFileFor(ghConfig);
{
  const saved = loadSettings(SETTINGS_FILE);
  if (saved.githubToken) ghConfig.token = saved.githubToken;
}
const collector = new Collector(ghConfig);

function tokenSource() {
  if (!ghConfig.token) return null;
  return ghConfig.token === ENV_TOKEN ? 'env' : 'settings';
}

// CORS: Override Cloudflare Access headers to prevent arbitrary origin reflection.
// ALLOWED_ORIGINS lets a self-hosted instance add its own LAN hostnames.
const ALLOWED_ORIGINS = [
  'https://audits.neuhard.dev',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Max-Age', '86400');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/** Parse a positive integer query param; undefined when absent or malformed. */
function intParam(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// === API Endpoints ===

// Liveness probe for container healthchecks: no filesystem or GitHub work,
// answers as long as the event loop is alive. /health below is the rich one.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Rich readiness: what the collector currently holds. /healthz above is the
// cheap liveness probe; this one is for humans and monitoring.
app.get('/health', (req, res) => {
  const status = collector.getStatus();
  const summary = collector.state.summary;
  res.json({
    status: 'ok',
    version: pkg.version,
    buildDate: process.env.BUILD_DATE || null,
    github: {
      configured: ghConfig.enabled,
      fetchedAt: status.fetchedAt,
      stale: status.freshness.stale,
      repoCount: status.repoCount,
      errorCount: status.errors.length
    },
    alerts: summary?.alerts || { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    coveragePercent: summary?.coverage?.percent ?? null,
    openPrs: summary?.prs?.total ?? 0,
    history: collector.history.meta
  });
});

app.get('/api/version', (req, res) => res.json({ version: pkg.version, buildDate: process.env.BUILD_DATE || null }));

// === GitHub / Dependabot endpoints =======================================
//
// These read from the background collector's cache, so the UI never waits on
// the GitHub API. `/api/gh/status` always answers, even unconfigured, so the
// frontend can render a setup screen instead of an error.

function requireGitHub(req, res, next) {
  if (!ghConfig.enabled) {
    return res.status(503).json({
      error: 'GitHub integration not configured',
      hint: 'Set GITHUB_TOKEN (a PAT with repo + security_events scope) and restart.'
    });
  }
  next();
}

app.get('/api/gh/status', (req, res) => res.json(collector.getStatus()));

app.get('/api/gh/overview', requireGitHub, (req, res) => {
  res.json({
    status: collector.getStatus(),
    summary: collector.state.summary,
    gaps: collector.getCoverageGaps()
  });
});

app.get('/api/gh/repos', requireGitHub, (req, res) => {
  const { filter, search, sort } = req.query;
  res.json(collector.getRepos({ filter, search, sort }));
});

app.get('/api/gh/prs', requireGitHub, (req, res) => {
  res.json(collector.getPullRequests({ kind: req.query.kind || 'all' }));
});

app.get('/api/gh/alerts', requireGitHub, (req, res) => {
  res.json(collector.getAlerts({ severity: req.query.severity, repo: req.query.repo }));
});

app.get('/api/gh/coverage', requireGitHub, (req, res) => res.json(collector.getCoverageGaps()));

// Merged pull requests — what actually got patched, and the only backward-
// looking record GitHub keeps for a repo we do not otherwise track over time.
app.get('/api/gh/merges', requireGitHub, (req, res) => {
  res.json(collector.getMerges({ days: intParam(req.query.days), kind: req.query.kind || 'all' }));
});

// Cross-repo security posture: which scanning features are on, off, or
// invisible to this token. Wider than /api/gh/coverage, which is Dependabot only.
app.get('/api/gh/posture', requireGitHub, (req, res) => res.json(collector.getPosture()));

// The local scan-snapshot series. `recorded` grows from the moment this
// dashboard first ran; `derived` reconstructs the same window from the dates
// carried by currently-open alerts and PRs, so the charts are populated on
// day one. Derived points are a floor — anything already fixed is not in them.
app.get('/api/gh/trends', requireGitHub, (req, res) => {
  res.json(collector.getTrends({ days: intParam(req.query.days) ?? 90 }));
});

app.get('/api/gh/history', requireGitHub, (req, res) => {
  res.json(collector.getHistory({ days: intParam(req.query.days), limit: intParam(req.query.limit) ?? 100 }));
});

app.get('/api/gh/calendar', requireGitHub, (req, res) => {
  res.json(collector.getCalendar({ days: intParam(req.query.days) ?? 90 }));
});

// The agent-facing work queue: verdicts + literal gh commands, with the
// staleness contract so callers refresh-then-read (POST /api/gh/refresh
// blocks until the cache is fresh).
app.get('/api/gh/actions', requireGitHub, (req, res) => res.json(collector.getActions()));

// Conflict-aware merge ordering: which merges can run in parallel, which must
// queue behind a rebase. Derived from PR file overlap (lockfiles, usually).
app.get('/api/gh/merge-plan', requireGitHub, (req, res) => res.json(collector.getMergePlan()));

// Settings: the UI can supply the GitHub token so nobody has to touch
// compose/Portainer env. Write-only for secrets — the GET reports source and
// the last four characters, never the token itself. Requiring a JSON body
// means cross-origin posts hit a CORS preflight our middleware won't approve.
app.get('/api/settings', (req, res) => {
  res.json({
    github: {
      configured: ghConfig.enabled,
      source: tokenSource(),
      tokenTail: tokenTail(ghConfig.token),
      envTokenPresent: Boolean(ENV_TOKEN),
      viewer: collector.state.viewer
    }
  });
});

app.post('/api/settings/token', express.json({ limit: '4kb' }), async (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send application/json' });
  const token = String(req.body?.token ?? '').trim();

  if (token === '') {
    // Clear the saved token; the env token (if any) takes back over.
    const saved = loadSettings(SETTINGS_FILE);
    delete saved.githubToken;
    try { saveSettings(SETTINGS_FILE, saved); } catch (e) {
      return res.status(500).json({ error: `Could not persist settings: ${e.message}` });
    }
    ghConfig.token = ENV_TOKEN;
    collector.setToken(ENV_TOKEN);
    return res.json({ ok: true, cleared: true, source: tokenSource() });
  }

  if (!looksLikeGitHubToken(token)) {
    return res.status(400).json({ error: 'That does not look like a GitHub token (expected ghp_/github_pat_/gho_… format).' });
  }

  // Prove the token works before accepting it.
  let viewer;
  try {
    const probe = new GitHubClient({ token, apiUrl: ghConfig.apiUrl });
    const me = await probe.get('/user');
    viewer = { login: me.login, name: me.name || null, avatar: me.avatar_url || null };
  } catch (e) {
    const detail = e.status === 401 ? 'GitHub rejected it (401)' : e.message;
    return res.status(400).json({ error: `Token validation failed: ${detail}` });
  }

  const saved = loadSettings(SETTINGS_FILE);
  saved.githubToken = token;
  try { saveSettings(SETTINGS_FILE, saved); } catch (e) {
    return res.status(500).json({ error: `Token is valid but could not be persisted: ${e.message}` });
  }
  ghConfig.token = token;
  collector.setToken(token);
  collector.refresh().catch(() => {}); // background; first scan may take a minute
  res.json({ ok: true, viewer, source: 'settings' });
});

// Live probe: what can the CURRENT token actually see? One cheap request per
// permission against up to three repos (fine-grained PATs answer 403/404 for
// missing grants, so a single repo can be ambiguous). ~7 API calls total.
app.get('/api/settings/access', async (req, res) => {
  if (!ghConfig.enabled) return res.status(503).json({ error: 'No token configured' });
  const probe = new GitHubClient({ token: ghConfig.token, apiUrl: ghConfig.apiUrl });
  const access = {
    metadata: 'unknown', dependabot_alerts: 'unknown', pull_requests: 'unknown',
    contents: 'unknown', actions: 'unknown', administration: 'unknown',
    code_scanning: 'unknown'
  };
  let repos;
  try {
    repos = (await probe.get('/user/repos?per_page=3&sort=pushed')) || [];
    access.metadata = 'ok';
  } catch {
    access.metadata = 'denied';
    return res.json({ checkedAt: new Date().toISOString(), probedRepos: [], access });
  }
  // Administration read makes security_and_analysis appear on the SINGLE-repo
  // object — the list endpoint withholds it at every privilege level, so it
  // must never be used as the probe (that mistake shipped once already).
  const names = repos.map(r => r.full_name);
  if (names.length) {
    for (const name of names) {
      try {
        const detail = await probe.get(`/repos/${name}`);
        if (detail?.security_and_analysis != null) { access.administration = 'ok'; break; }
        access.administration = 'denied';
      } catch { access.administration = 'unknown'; }
    }
  }
  // Third element: statuses that prove the GRANT works even though the
  // feature answers negatively. Code scanning returns 404 when the repo has
  // no analyses — that is a scoped token seeing an honest "nothing here",
  // while a missing grant is a 403.
  const CHECKS = [
    ['dependabot_alerts', r => `/repos/${r}/dependabot/alerts?per_page=1`],
    ['pull_requests', r => `/repos/${r}/pulls?per_page=1&state=open`],
    ['contents', r => `/repos/${r}/contents/`],
    ['actions', r => `/repos/${r}/actions/runs?per_page=1`],
    ['code_scanning', r => `/repos/${r}/code-scanning/analyses?per_page=1`, [404]]
  ];
  await Promise.all(CHECKS.map(async ([key, pathFor, okAnyway = []]) => {
    for (const name of names) {
      try {
        const { status } = await probe.request(pathFor(name), { allowStatus: [401, 403, 404] });
        if ((status >= 200 && status < 300) || okAnyway.includes(status)) { access[key] = 'ok'; return; }
        access[key] = 'denied'; // keep trying — another repo may say yes
      } catch { access[key] = 'unknown'; }
    }
  }));
  res.json({ checkedAt: new Date().toISOString(), probedRepos: names, access });
});

// Self-description: the machine-readable spec and the markdown briefing.
// Both answer even unconfigured — the digest says so instead of erroring.
app.get('/api/openapi.json', (req, res) => res.json(openapiSpec));

app.get('/api/digest.md', (req, res) => {
  const md = buildDigest({
    status: collector.getStatus(),
    summary: collector.state.summary,
    actions: ghConfig.enabled ? collector.getActions() : null
  });
  res.type('text/markdown').send(md);
});

app.post('/api/gh/refresh', requireGitHub, async (req, res) => {
  try {
    await collector.refresh();
    res.json({ ok: true, status: collector.getStatus() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// An unknown /api/* path is a client error, not a page. Without this the SPA
// catch-all below answers 200 text/html, so a mistyped or removed endpoint
// looks like a success to anything expecting JSON.
app.all(/^\/api(?:\/.*)?$/, (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}`, hint: 'See /api/openapi.json' });
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (ghConfig.enabled) {
  console.log(`GitHub integration enabled — refreshing every ${ghConfig.refreshMinutes}m` +
    (ghConfig.owners.length ? ` for ${ghConfig.owners.join(', ')}` : ' for all accessible repos'));
  collector.start();
} else {
  console.log('GitHub integration disabled — set GITHUB_TOKEN to enable the Patch view');
}

app.listen(PORT, () => console.log(`Audit dashboard on port ${PORT}`));
