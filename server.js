const express = require('express');
const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./lib/config');
const { Collector } = require('./lib/collector');
const { buildDigest } = require('./lib/digest');
const { spec: openapiSpec } = require('./lib/openapi');
const { GitHubClient } = require('./lib/github');
const { settingsFileFor, loadSettings, saveSettings, tokenTail, looksLikeGitHubToken } = require('./lib/settings');

const app = express();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
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

// Helper: get sorted date dirs
function getDates() {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name).sort();
  } catch { return []; }
}

// Helper: get all reports for a date
function getReportsForDate(date) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const reports = [];
  for (const f of files) {
    try {
      const name = f.replace('.json', '');
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      reports.push(normalize(name, data));
    } catch {}
  }
  return reports;
}

// Helper: calc health score from reports
function calcHealthScore(reports) {
  const scores = reports.filter(r => r.agent !== 'meta' && r.agent !== 'digest' && r.score != null).map(r => Math.min(100, r.score));
  if (!scores.length) return null;
  return Math.min(100, Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
}

// Helper: get meta info
function getMetaInfo(reports) {
  const meta = reports.find(r => r.agent === 'meta');
  const raw = meta?.raw || {};
  return {
    lastRunTime: raw.endTime || null,
    lastRunDuration: raw.durationSeconds || null
  };
}

// Helper: grade from score
function gradeFromScore(score) {
  if (score == null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// Helper: collect all findings across all dates
function collectAllFindings() {
  const dates = getDates();
  if (!dates.length) return [];
  const latestDate = dates[dates.length - 1];
  const findingsMap = {};

  for (const date of dates) {
    const dir = path.join(DATA_DIR, date);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'meta.json'); } catch { continue; }
    for (const f of files) {
      try {
        const agentName = f.replace('.json', '');
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        let findings = [];
        if (Array.isArray(data.findings)) {
          findings = data.findings;
        } else if (data.findings && typeof data.findings === 'object') {
          for (const arr of Object.values(data.findings)) {
            if (Array.isArray(arr)) findings.push(...arr);
          }
        }
        if (Array.isArray(data.repos)) {
          for (const repo of data.repos) {
            if (Array.isArray(repo.findings)) findings.push(...repo.findings.map(ff => ({ ...ff, repo: repo.name || repo.repo })));
          }
        }
        if (Array.isArray(data.priorities)) {
          findings.push(...data.priorities.map(p => ({ severity: p.severity || 'medium', title: p.title, repo: p.repo })));
        }

        for (const finding of findings) {
          const title = finding.title || finding.id || 'Unknown';
          const key = title.toLowerCase().trim();
          if (!findingsMap[key]) {
            findingsMap[key] = {
              id: finding.id || key.slice(0, 8),
              title,
              severity: finding.severity || 'info',
              repo: finding.repo || agentName,
              agent: agentName,
              firstSeen: date,
              lastSeen: date,
              occurrences: 1,
              status: 'new'
            };
          } else {
            findingsMap[key].lastSeen = date;
            findingsMap[key].occurrences++;
            if (!findingsMap[key].repo && finding.repo) findingsMap[key].repo = finding.repo;
          }
        }
      } catch {}
    }
  }

  const result = Object.values(findingsMap).map(f => {
    if (f.lastSeen !== latestDate) f.status = 'resolved';
    else if (f.firstSeen === latestDate) f.status = 'new';
    else f.status = 'recurring';
    return f;
  });

  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  result.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));
  return result;
}

// Helper: finding counts from security report
function getFindingCounts(reports) {
  const sec = reports.find(r => r.agent === 'security');
  const counts = sec?.findingCounts || {};
  return { critical: counts.critical || 0, high: counts.high || 0, medium: counts.medium || 0, low: counts.low || 0 };
}

function normalize(name, data) {
  const base = { agent: name, raw: data };
  try {
    switch (name) {
      case 'security': {
        const s = data.summary || {};
        const score = Math.max(0, 100 - (s.critical||0)*25 - (s.high||0)*10 - (s.medium||0)*5 - (s.low||0)*2);
        return { ...base, status: s.critical > 0 ? 'critical' : s.high > 0 ? 'warning' : 'ok',
          score, summary: `${s.total||0} findings: ${s.critical||0}C / ${s.high||0}H / ${s.medium||0}M / ${s.low||0}L`,
          findings: data.findings || [], findingCounts: s };
      }
      case 'quality': {
        // repos can be dict {repoName: {grade, ...}} or array
        const repos = data.repos || {};
        const repoEntries = Array.isArray(repos) ? repos : Object.entries(repos).map(([name, v]) => ({ name, ...v }));
        const gradeMap = { 'A+': 97, 'A': 95, 'A-': 92, 'B+': 88, 'B': 85, 'B-': 82, 'C+': 78, 'C': 75, 'C-': 72, 'D+': 68, 'D': 65, 'D-': 62, 'F': 40 };
        const scores = repoEntries.map(r => r.score ?? gradeMap[r.grade] ?? 0).filter(s => s > 0);
        const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : (data.score || 0);
        const avgGrade = data.grade || (avgScore >= 90 ? 'A' : avgScore >= 80 ? 'B' : avgScore >= 70 ? 'C' : avgScore >= 60 ? 'D' : 'F');
        return { ...base, status: avgScore >= 85 ? 'ok' : avgScore >= 70 ? 'warning' : 'critical',
          score: avgScore, grade: avgGrade, summary: data.summary || `${repoEntries.length} repos analyzed`, repos: repoEntries };
      }
      case 'infra': {
        const ciEntries = Object.values(data.ci || {});
        // successRate comes as 0-100 percentage, normalize to 0-1
        const avgCI = ciEntries.length ? ciEntries.reduce((a,c) => a + (c.successRate||0), 0) / ciEntries.length / 100 : 0;
        const containers = data.containers || [];
        const running = containers.filter(c => c.state === 'running').length;
        const score = Math.min(100, Math.round(avgCI * 70 + (running === containers.length && containers.length > 0 ? 30 : 0)));
        const hasCrit = (data.alerts||[]).some(a => a.severity === 'critical');
        return { ...base, status: hasCrit ? 'critical' : avgCI < 0.7 ? 'warning' : 'ok',
          score, summary: `${running}/${containers.length} containers · CI avg ${Math.round(avgCI*100)}%`,
          ci: data.ci, containers, alerts: data.alerts || [], disk: data.disk };
      }
      case 'dependencies': {
        const s = data.summary || {};
        const total = s.totalVulnerabilities || 0;
        const score = Math.max(0, 100 - (s.critical||0)*25 - (s.high||0)*2 - (s.moderate||0));
        return { ...base, status: (s.critical||0) > 0 ? 'critical' : (s.high||0) > 0 ? 'warning' : 'ok',
          score, summary: `${total} vulns: ${s.critical||0}C / ${s.high||0}H / ${s.moderate||0}M`,
          repos: data.repos || {}, depSummary: s };
      }
      case 'lighthouse': {
        const sites = data.sites || {};
        const entries = Object.entries(sites).filter(([,v]) => v.scores);
        const avg = entries.length ? Math.round(entries.reduce((a,[,v]) => a + (v.scores.performance||0), 0) / entries.length) : 0;
        return { ...base, status: avg >= 80 ? 'ok' : avg >= 50 ? 'warning' : 'critical',
          score: avg, summary: `Avg perf: ${avg}`, sites };
      }
      case 'consistency': {
        const cScore = data.consistencyScore ?? data.score ?? 0;
        return { ...base, status: cScore >= 70 ? 'ok' : cScore >= 50 ? 'warning' : 'critical',
          score: cScore, summary: data.summary || '',
          findings: data.findings || {}, recommendations: data.recommendations || [] };
      }
      case 'roadmap': {
        // portfolioHealth can be a number or derive from projectHealth object
        let phScore = data.portfolioHealth ?? 0;
        let healthScores = data.healthScores || {};
        if (!phScore && data.projectHealth && typeof data.projectHealth === 'object') {
          const entries = Object.entries(data.projectHealth);
          healthScores = Object.fromEntries(entries.map(([k, v]) => [k, v.score ?? 0]));
          const vals = Object.values(healthScores);
          phScore = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
        }
        return { ...base, status: phScore >= 70 ? 'ok' : phScore >= 50 ? 'warning' : 'critical',
          score: phScore, summary: `Portfolio health: ${phScore}%`,
          healthScores, priorities: data.priorities || [], quickWins: data.quickWins || [] };
      }
      case 'digest':
        return { ...base, status: 'ok', score: null, summary: '',
          healthScores: data.healthScores || {}, topPriorities: data.topPriorities || [] };
      case 'meta':
        return { ...base, status: 'ok' };
      default:
        return base;
    }
  } catch (e) {
    console.warn(`normalize error for ${name}:`, e.message);
    return { ...base, status: 'unknown', score: null, summary: 'Error normalizing' };
  }
}

// === API Endpoints ===

// Liveness probe for container healthchecks: no filesystem or GitHub work,
// answers as long as the event loop is alive. /health below is the rich one.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// #4: Enriched health
app.get('/health', (req, res) => {
  const dates = getDates();
  const latestDate = dates[dates.length - 1] || null;
  const reports = latestDate ? getReportsForDate(latestDate) : [];
  const metaInfo = getMetaInfo(reports);
  const healthScore = calcHealthScore(reports);
  const agentReports = reports.filter(r => r.agent !== 'meta' && r.agent !== 'digest');
  res.json({
    status: 'ok',
    version: pkg.version,
    buildDate: process.env.BUILD_DATE || null,
    lastAuditDate: latestDate,
    lastRunTime: metaInfo.lastRunTime,
    lastRunDuration: metaInfo.lastRunDuration,
    healthScore,
    agentCount: agentReports.length,
    findingCounts: getFindingCounts(reports),
    github: {
      configured: ghConfig.enabled,
      fetchedAt: collector.state.fetchedAt,
      repoCount: collector.state.repos.length
    }
  });
});

app.get('/api/version', (req, res) => res.json({ version: pkg.version, buildDate: process.env.BUILD_DATE || null }));

// List dates
app.get('/api/dates', (req, res) => {
  res.json(getDates().reverse());
});

// #1: Summary endpoint
app.get('/api/summary', (req, res) => {
  const dates = getDates();
  if (!dates.length) return res.json({ error: 'No data' });
  const latestDate = dates[dates.length - 1];
  const reports = getReportsForDate(latestDate);
  const healthScore = calcHealthScore(reports);
  const metaInfo = getMetaInfo(reports);

  // Delta from previous date
  let delta = null;
  if (dates.length >= 2) {
    const prevReports = getReportsForDate(dates[dates.length - 2]);
    const prevScore = calcHealthScore(prevReports);
    if (healthScore != null && prevScore != null) delta = healthScore - prevScore;
  }

  const agents = reports
    .filter(r => r.agent !== 'meta' && r.agent !== 'digest')
    .map(r => ({ name: r.agent, score: r.score, grade: r.grade || gradeFromScore(r.score), status: r.status }));

  // Top priorities from digest or roadmap
  const digest = reports.find(r => r.agent === 'digest');
  const roadmap = reports.find(r => r.agent === 'roadmap');
  const topPriorities = digest?.topPriorities || roadmap?.priorities?.slice(0, 5)?.map(p => p.title) || [];

  res.json({
    date: latestDate,
    healthScore,
    delta,
    agents,
    findingCounts: getFindingCounts(reports),
    topPriorities,
    lastRunDuration: metaInfo.lastRunDuration,
    lastRunTime: metaInfo.lastRunTime
  });
});

// #2: Findings with query params
app.get('/api/findings', (req, res) => {
  try {
    let findings = collectAllFindings();
    const { status, severity, repo, agent, limit, sort } = req.query;

    if (status) findings = findings.filter(f => f.status === status);
    if (severity) findings = findings.filter(f => f.severity === severity);
    if (repo) findings = findings.filter(f => f.repo && f.repo.toLowerCase().includes(repo.toLowerCase()));
    if (agent) findings = findings.filter(f => f.agent && f.agent.toLowerCase() === agent.toLowerCase());

    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    if (sort === 'firstSeen') findings.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    else if (sort === 'status') {
      const sOrder = { 'new': 0, recurring: 1, resolved: 2 };
      findings.sort((a, b) => (sOrder[a.status] ?? 3) - (sOrder[b.status] ?? 3));
    } else {
      findings.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));
    }

    if (limit) findings = findings.slice(0, parseInt(limit, 10));
    res.json(findings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// #3: Diff endpoint
app.get('/api/diff/:date1/:date2?', (req, res) => {
  try {
    const dates = getDates();
    const date1 = req.params.date1;
    let date2 = req.params.date2;
    if (!date2) {
      const idx = dates.indexOf(date1);
      date2 = idx > 0 ? dates[idx - 1] : null;
    }
    if (!date2) return res.status(400).json({ error: 'No previous date available' });

    const reports1 = getReportsForDate(date1);
    const reports2 = getReportsForDate(date2);

    const AGENT_ORDER = ['security', 'quality', 'infra', 'dependencies', 'lighthouse', 'consistency', 'roadmap'];
    const byAgent1 = {}; reports1.forEach(r => { byAgent1[r.agent] = r; });
    const byAgent2 = {}; reports2.forEach(r => { byAgent2[r.agent] = r; });

    const scoreChanges = AGENT_ORDER.map(agent => ({
      agent,
      before: byAgent2[agent]?.score ?? null,
      after: byAgent1[agent]?.score ?? null,
      delta: (byAgent1[agent]?.score != null && byAgent2[agent]?.score != null) ? byAgent1[agent].score - byAgent2[agent].score : null
    }));

    // Collect findings
    function collectFromReports(reports) {
      const findings = [];
      for (const r of reports) {
        if (Array.isArray(r.findings)) findings.push(...r.findings.map(f => ({ ...f, agent: r.agent })));
        if (r.findings && typeof r.findings === 'object' && !Array.isArray(r.findings)) {
          for (const arr of Object.values(r.findings)) {
            if (Array.isArray(arr)) findings.push(...arr.map(f => ({ ...f, agent: r.agent })));
          }
        }
        if (Array.isArray(r.priorities)) {
          findings.push(...r.priorities.map(p => ({ severity: p.severity || 'medium', title: p.title, repo: p.repo, agent: r.agent })));
        }
      }
      return findings;
    }

    const findings1 = collectFromReports(reports1);
    const findings2 = collectFromReports(reports2);
    const titles2 = new Set(findings2.map(f => (f.title || '').toLowerCase()));
    const titles1 = new Set(findings1.map(f => (f.title || '').toLowerCase()));

    res.json({
      date1,
      date2,
      scoreChanges,
      newFindings: findings1.filter(f => !titles2.has((f.title || '').toLowerCase())),
      resolvedFindings: findings2.filter(f => !titles1.has((f.title || '').toLowerCase()))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// #5: Trends with filtering
app.get('/api/trends', (req, res) => {
  try {
    let dates = getDates();
    const { days, agent: agentParam, agents: agentsParam } = req.query;

    if (days) {
      const n = parseInt(days, 10);
      if (n > 0 && dates.length > n) dates = dates.slice(-n);
    }

    const agentFilter = agentParam ? [agentParam] : agentsParam ? agentsParam.split(',') : null;

    const trends = { dates: [], data: {} };
    for (const date of dates) {
      trends.dates.push(date);
      let files;
      try { files = fs.readdirSync(path.join(DATA_DIR, date)).filter(f => f.endsWith('.json') && f !== 'meta.json'); } catch { continue; }
      for (const f of files) {
        try {
          const name = f.replace('.json', '');
          if (agentFilter && !agentFilter.includes(name)) continue;
          const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, date, f), 'utf8'));
          const n = normalize(name, raw);
          if (!trends.data[name]) trends.data[name] = [];
          trends.data[name].push({ date, score: n.score, status: n.status });
        } catch {}
      }
    }
    res.json(trends);
  } catch { res.json({ dates: [], data: {} }); }
});

// All reports for a date
app.get('/api/report/:date', (req, res) => {
  const reports = getReportsForDate(req.params.date);
  if (!reports.length) return res.status(404).json({ error: 'Not found' });
  res.json(reports);
});

// Single agent
app.get('/api/report/:date/:agent', (req, res) => {
  const fp = path.join(DATA_DIR, req.params.date, `${req.params.agent}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    res.json(normalize(req.params.agent, data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Markdown
app.get('/api/report/:date/:agent/md', (req, res) => {
  const fp = path.join(DATA_DIR, req.params.date, `${req.params.agent}.md`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain').send(fs.readFileSync(fp, 'utf8'));
});

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
    contents: 'unknown', actions: 'unknown', administration: 'unknown'
  };
  let repos = [];
  try {
    repos = (await probe.get('/user/repos?per_page=3&sort=pushed')) || [];
    access.metadata = 'ok';
  } catch {
    access.metadata = 'denied';
    return res.json({ checkedAt: new Date().toISOString(), probedRepos: [], access });
  }
  // Administration read makes security_and_analysis appear on the repo object.
  if (repos.length) {
    access.administration = repos.some(r => r.security_and_analysis != null) ? 'ok' : 'denied';
  }
  const CHECKS = [
    ['dependabot_alerts', r => `/repos/${r}/dependabot/alerts?per_page=1`],
    ['pull_requests', r => `/repos/${r}/pulls?per_page=1&state=open`],
    ['contents', r => `/repos/${r}/contents/`],
    ['actions', r => `/repos/${r}/actions/runs?per_page=1`]
  ];
  const names = repos.map(r => r.full_name);
  await Promise.all(CHECKS.map(async ([key, pathFor]) => {
    for (const name of names) {
      try {
        const { status } = await probe.request(pathFor(name), { allowStatus: [401, 403, 404] });
        if (status >= 200 && status < 300) { access[key] = 'ok'; return; }
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (ghConfig.enabled) {
  console.log(`GitHub integration enabled — refreshing every ${ghConfig.refreshMinutes}m` +
    (ghConfig.owners.length ? ` for ${ghConfig.owners.join(', ')}` : ' for all accessible repos'));
  collector.start();
} else {
  console.log('GitHub integration disabled — set GITHUB_TOKEN to enable the Patch view');
}

app.listen(PORT, () => console.log(`Audit dashboard on port ${PORT}`));
