const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { loadConfig, repoSelected, matchesAny } = require('../lib/config');
const { GitHubClient, parseNextLink } = require('../lib/github');
const posture = require('../lib/posture');
const { Collector, mapLimit, parseDependabotConfig, rollupChecks } = require('../lib/collector');

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const ago = days => new Date(NOW - days * DAY).toISOString();

// === config ==============================================================

describe('config', () => {
  it('reads defaults and env overrides', () => {
    const c = loadConfig({});
    assert.equal(c.enabled, false);
    assert.equal(c.refreshMinutes, 30);
    assert.equal(c.staleDays, 14);

    const c2 = loadConfig({ GITHUB_TOKEN: 'abc', GH_REFRESH_MINUTES: '60', GH_OWNERS: 'me, myorg', GH_INCLUDE_ARCHIVED: 'true' });
    assert.equal(c2.enabled, true);
    assert.equal(c2.refreshMinutes, 60);
    assert.deepEqual(c2.owners, ['me', 'myorg']);
    assert.equal(c2.includeArchived, true);
  });

  it('clamps the refresh interval to a polite floor', () => {
    assert.equal(loadConfig({ GH_REFRESH_MINUTES: '1' }).refreshMinutes, 5);
  });

  it('matches glob patterns on both full and short names', () => {
    assert.equal(matchesAny(['me/*'], 'me/thing'), true);
    assert.equal(matchesAny(['thing'], 'me/thing'), true);
    assert.equal(matchesAny(['*-dashboard'], 'me/audit-dashboard'), true);
    assert.equal(matchesAny(['other/*'], 'me/thing'), false);
  });

  it('applies include/exclude/archived/fork selection', () => {
    const config = loadConfig({ GH_REPOS_EXCLUDE: 'me/scratch*' });
    assert.equal(repoSelected({ full_name: 'me/app' }, config), true);
    assert.equal(repoSelected({ full_name: 'me/scratchpad' }, config), false);
    assert.equal(repoSelected({ full_name: 'me/app', archived: true }, config), false);
    assert.equal(repoSelected({ full_name: 'me/app', fork: true }, config), false);

    const onlyOne = loadConfig({ GH_REPOS_INCLUDE: 'me/app' });
    assert.equal(repoSelected({ full_name: 'me/other' }, onlyOne), false);
  });
});

// === github client =======================================================

function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) },
    json: async () => body
  };
}

describe('github client', () => {
  it('parses rel="next" out of Link headers', () => {
    const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    assert.equal(parseNextLink(link), 'https://api.github.com/x?page=2');
    assert.equal(parseNextLink(null), null);
    assert.equal(parseNextLink('<https://x>; rel="prev"'), null);
  });

  it('serves 304 responses from the ETag cache without a second body', async () => {
    let calls = 0;
    const fetchImpl = async (url, opts) => {
      calls++;
      if (opts.headers['if-none-match']) return fakeResponse({ status: 304, headers: { etag: 'W/"1"' } });
      return fakeResponse({ body: { hello: 'world' }, headers: { etag: 'W/"1"' } });
    };
    const client = new GitHubClient({ token: 't', fetchImpl });
    assert.deepEqual(await client.get('/x'), { hello: 'world' });
    const second = await client.request('/x');
    assert.equal(second.notModified, true);
    assert.deepEqual(second.data, { hello: 'world' });
    assert.equal(calls, 2);
  });

  it('returns null instead of throwing for allowed statuses', async () => {
    const client = new GitHubClient({ token: 't', fetchImpl: async () => fakeResponse({ status: 404, body: { message: 'Not Found' } }) });
    assert.equal(await client.get('/missing', { allowStatus: [404] }), null);
    await assert.rejects(() => client.get('/missing'), /404/);
  });

  it('records rate-limit headers', async () => {
    const client = new GitHubClient({
      token: 't',
      fetchImpl: async () => fakeResponse({ body: {}, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990' } })
    });
    await client.get('/user');
    assert.equal(client.rate.limit, 5000);
    assert.equal(client.rate.remaining, 4990);
  });

  it('follows pagination up to maxPages', async () => {
    const client = new GitHubClient({
      token: 't',
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get('page') || 1);
        return fakeResponse({
          body: [{ n: page }],
          headers: page < 3 ? { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` } : {}
        });
      }
    });
    const all = await client.paginate('https://api.github.com/x?page=1', { maxPages: 5 });
    assert.deepEqual(all.map(r => r.n), [1, 2, 3]);
  });
});

// === posture =============================================================

describe('posture', () => {
  it('classifies PR authorship', () => {
    assert.equal(posture.classifyPr({ user: { login: 'dependabot[bot]' } }), 'dependabot');
    assert.equal(posture.classifyPr({ user: { login: 'someone' }, head: { ref: 'dependabot/npm_and_yarn/x' } }), 'dependabot');
    assert.equal(posture.classifyPr({ user: { login: 'renovate[bot]' } }), 'renovate');
    assert.equal(posture.classifyPr({ user: { login: 'other[bot]', type: 'Bot' } }), 'bot');
    assert.equal(posture.classifyPr({ user: { login: 'jtn0123' } }), 'human');
  });

  it('parses bump titles', () => {
    assert.deepEqual(posture.parseBumpTitle('build(deps): bump express from 4.18.0 to 4.21.0'),
      { package: 'express', from: '4.18.0', to: '4.21.0' });
    assert.equal(posture.parseBumpTitle('Add a feature'), null);
  });

  it('picks the freshest scan signal and names its source', () => {
    const scan = posture.resolveLastScan({
      dependabotRunAt: ago(10),
      alertUpdatedAt: ago(2),
      dependabotPrAt: ago(30)
    }, NOW);
    assert.equal(scan.source, 'alert-activity');
    assert.equal(scan.ageDays, 2);

    const none = posture.resolveLastScan({}, NOW);
    assert.equal(none.source, 'none');
    assert.equal(none.at, null);
  });

  it('flags a repo with no config, no alerts and no scan', () => {
    const p = posture.buildRepoPosture({
      repo: { name: 'bare', full_name: 'me/bare', owner: { login: 'me' } },
      config: { present: false, ecosystems: [] },
      alertsEnabled: false,
      securityUpdatesEnabled: false,
      alerts: [],
      pulls: []
    }, { now: NOW });

    const ids = p.gaps.map(g => g.id);
    assert.ok(ids.includes('no-dependabot-config'));
    assert.ok(ids.includes('alerts-disabled'));
    assert.ok(ids.includes('security-updates-disabled'));
    assert.equal(p.action.text, 'Turn on Dependabot alerts');
    assert.ok(p.risk >= 60);
  });

  it('scores unpatched criticals above stale config gaps', () => {
    const vulnerable = posture.buildRepoPosture({
      repo: { name: 'v', full_name: 'me/v' },
      config: { present: true, path: '.github/dependabot.yml', ecosystems: [{ ecosystem: 'npm' }] },
      alertsEnabled: true,
      securityUpdatesEnabled: true,
      alerts: [{ number: 1, security_vulnerability: { severity: 'critical', package: { name: 'lodash' } }, created_at: ago(3), updated_at: ago(1) }],
      pulls: []
    }, { now: NOW });

    const tidy = posture.buildRepoPosture({
      repo: { name: 't', full_name: 'me/t' },
      config: { present: false, ecosystems: [] },
      alertsEnabled: true,
      securityUpdatesEnabled: true,
      alerts: [],
      pulls: []
    }, { now: NOW });

    assert.ok(vulnerable.risk > tidy.risk);
    assert.equal(vulnerable.action.text, 'Patch 1 critical alert');
    assert.equal(vulnerable.alerts.counts.critical, 1);
  });

  it('separates bot PRs from human PRs and marks stale ones', () => {
    const p = posture.buildRepoPosture({
      repo: { name: 'x', full_name: 'me/x' },
      config: { present: true, ecosystems: [] },
      alertsEnabled: true,
      alerts: [],
      pulls: [
        { number: 1, title: 'bump a from 1 to 2', user: { login: 'dependabot[bot]' }, created_at: ago(40), updated_at: ago(40), head: { ref: 'dependabot/npm_and_yarn/a' } },
        { number: 2, title: 'my feature', user: { login: 'jtn0123' }, created_at: ago(2), updated_at: ago(1), head: { ref: 'feat' } }
      ]
    }, { now: NOW });

    assert.equal(p.prs.counts.dependabot, 1);
    assert.equal(p.prs.counts.other, 1);
    assert.equal(p.prs.counts.stale, 1);
    assert.ok(p.gaps.some(g => g.id === 'stale-prs'));
    assert.equal(p.prs.dependabot[0].bump.package, 'a');
  });

  it('discounts archived repos', () => {
    const raw = {
      repo: { name: 'old', full_name: 'me/old', archived: true },
      config: { present: false, ecosystems: [] },
      alertsEnabled: true,
      alerts: [{ number: 1, security_vulnerability: { severity: 'high', package: { name: 'x' } }, created_at: ago(5), updated_at: ago(5) }],
      pulls: []
    };
    const archived = posture.buildRepoPosture(raw, { now: NOW });
    const live = posture.buildRepoPosture({ ...raw, repo: { ...raw.repo, archived: false } }, { now: NOW });
    assert.ok(archived.risk < live.risk);
    assert.ok(!archived.gaps.some(g => g.id === 'no-dependabot-config'));
  });

  it('summarizes coverage across repos', () => {
    const repos = [
      posture.buildRepoPosture({ repo: { name: 'a', full_name: 'me/a' }, config: { present: true, ecosystems: [] }, alertsEnabled: true, securityUpdatesEnabled: true, alerts: [], pulls: [], dependabotRunAt: ago(1) }, { now: NOW }),
      posture.buildRepoPosture({ repo: { name: 'b', full_name: 'me/b' }, config: { present: false, ecosystems: [] }, alertsEnabled: false, alerts: [], pulls: [] }, { now: NOW })
    ];
    const s = posture.summarize(repos, { staleDays: 14 });
    assert.equal(s.repoCount, 2);
    assert.equal(s.coverage.covered, 1);
    assert.equal(s.coverage.percent, 50);
    assert.deepEqual(s.coverage.noConfig, ['me/b']);
    assert.deepEqual(s.coverage.alertsOff, ['me/b']);
    assert.equal(s.topRisk[0].fullName, 'me/b');
  });
});

// === collector helpers ===================================================

describe('collector helpers', () => {
  it('reads ecosystems and schedules out of dependabot.yml', () => {
    const parsed = parseDependabotConfig(`version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "docker"
    directory: "/app"
    schedule:
      interval: "daily"
`);
    assert.deepEqual(parsed.ecosystems.map(e => e.ecosystem), ['npm', 'docker']);
    assert.equal(parsed.ecosystems[1].directory, '/app');
    assert.deepEqual(parsed.schedules, ['weekly', 'daily']);
  });

  it('ignores commented-out ecosystems', () => {
    const parsed = parseDependabotConfig('#  - package-ecosystem: "pip"\n  - package-ecosystem: "npm"\n');
    assert.deepEqual(parsed.ecosystems.map(e => e.ecosystem), ['npm']);
  });

  it('rolls check runs up into one verdict', () => {
    assert.equal(rollupChecks([]).state, 'none');
    assert.equal(rollupChecks([{ status: 'completed', conclusion: 'success' }]).state, 'passing');
    assert.equal(rollupChecks([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }]).state, 'pending');
    assert.equal(rollupChecks([{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }]).state, 'failing');
    assert.equal(rollupChecks([{ status: 'completed', conclusion: 'skipped' }]).state, 'passing');
  });

  it('respects the concurrency ceiling', async () => {
    let active = 0, peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });
});

// === collector end-to-end (fake GitHub) ==================================

function fakeGitHub() {
  // Assertions inside fetchImpl would be swallowed by the collector's own
  // try/catch, so observations are recorded here and asserted in the test body.
  const seen = { dependabotRunEvents: [] };
  const repos = [
    { name: 'covered', full_name: 'me/covered', owner: { login: 'me' }, html_url: 'https://github.com/me/covered', default_branch: 'main', language: 'JavaScript', pushed_at: ago(1), private: false, security_and_analysis: { dependabot_security_updates: { status: 'enabled' }, secret_scanning: { status: 'enabled' } } },
    { name: 'naked', full_name: 'me/naked', owner: { login: 'me' }, html_url: 'https://github.com/me/naked', default_branch: 'main', language: 'Python', pushed_at: ago(200), private: true, security_and_analysis: { dependabot_security_updates: { status: 'disabled' } } },
    { name: 'fork', full_name: 'me/fork', owner: { login: 'me' }, fork: true, html_url: 'https://github.com/me/fork', security_and_analysis: {} }
  ];

  const fetchImpl = async function (url) {
    const { pathname, searchParams } = new URL(url);
    const json = (body, headers) => fakeResponse({ body, headers });

    if (pathname === '/user') return json({ login: 'me', name: 'Me' });
    if (pathname === '/user/repos') return json(repos);

    const m = pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (m) {
      const [, full, rest = ''] = m;
      if (rest === '' ) return json(repos.find(r => r.full_name === full) || {});
      if (rest.startsWith('/contents/')) {
        if (full === 'me/covered' && rest.endsWith('dependabot.yml')) {
          const yaml = 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n';
          return json({ content: Buffer.from(yaml).toString('base64'), encoding: 'base64' });
        }
        return fakeResponse({ status: 404, body: { message: 'Not Found' } });
      }
      if (rest.startsWith('/dependabot/alerts')) {
        if (full === 'me/naked') return fakeResponse({ status: 403, body: { message: 'Dependabot alerts are disabled for this repository.' } });
        return json([{
          number: 3,
          html_url: 'https://github.com/me/covered/security/dependabot/3',
          security_advisory: { summary: 'Prototype pollution', ghsa_id: 'GHSA-x', cve_id: 'CVE-2026-1' },
          security_vulnerability: { severity: 'high', package: { name: 'lodash', ecosystem: 'npm' }, first_patched_version: { identifier: '4.17.21' } },
          dependency: { manifest_path: 'package.json' },
          created_at: ago(6), updated_at: ago(2)
        }]);
      }
      if (rest.startsWith('/pulls')) {
        if (full !== 'me/covered') return json([]);
        return json([
          { number: 12, title: 'build(deps): bump lodash from 4.17.20 to 4.17.21', user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm_and_yarn/lodash-4.17.21', sha: 'sha1' }, base: { ref: 'main' }, created_at: ago(20), updated_at: ago(1), html_url: 'https://github.com/me/covered/pull/12', labels: [{ name: 'dependencies' }] },
          { number: 13, title: 'Add caching', user: { login: 'me' }, head: { ref: 'feat/cache', sha: 'sha2' }, base: { ref: 'main' }, created_at: ago(3), updated_at: ago(1), html_url: 'https://github.com/me/covered/pull/13', labels: [] }
        ]);
      }
      if (rest.startsWith('/actions/runs')) {
        // Two callers hit this path: the Dependabot-run lookup (event=dynamic)
        // and the default-branch CI check (branch=...). Only record the former.
        const event = searchParams.get('event');
        if (event) {
          seen.dependabotRunEvents.push(event);
          return json({ workflow_runs: full === 'me/covered' ? [{ created_at: ago(1) }] : [] });
        }
        return json({
          workflow_runs: [{
            status: 'completed',
            conclusion: full === 'me/naked' ? 'failure' : 'success',
            name: 'ci',
            html_url: `https://github.com/${full}/actions/runs/1`,
            updated_at: ago(1)
          }]
        });
      }
      if (rest.startsWith('/code-scanning/analyses')) return fakeResponse({ status: 404, body: { message: 'no analysis found' } });
      if (rest.includes('/check-runs')) {
        return json({ check_runs: rest.startsWith('/commits/sha1') ? [{ status: 'completed', conclusion: 'success' }] : [{ status: 'completed', conclusion: 'failure' }] });
      }
    }
    return fakeResponse({ status: 404, body: { message: 'Not Found' } });
  };
  return { fetchImpl, seen };
}

describe('collector end-to-end', () => {
  it('builds a full patch board from GitHub responses', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghtest-'));
    const cacheFile = path.join(cacheDir, 'cache.json');
    const config = loadConfig({ GITHUB_TOKEN: 'x', GH_CACHE_FILE: cacheFile, GH_HISTORY_FILE: path.join(cacheDir, 'history.jsonl'), GH_AUTO_REFRESH: 'false' });
    const { fetchImpl, seen } = fakeGitHub();
    // Fixed clock so ages, stale-scan gaps and risk stay deterministic forever.
    const collector = new Collector(config, { fetchImpl, now: () => NOW });

    const state = await collector.refresh();

    // Forks are excluded by default
    assert.equal(state.repos.length, 2);
    assert.equal(state.viewer.login, 'me');

    const covered = state.repos.find(r => r.fullName === 'me/covered');
    assert.equal(covered.dependabot.configPresent, true);
    assert.equal(covered.dependabot.configPath, '.github/dependabot.yml');
    assert.deepEqual(covered.dependabot.ecosystems.map(e => e.ecosystem), ['npm']);
    assert.equal(covered.dependabot.alertsEnabled, true);
    assert.equal(covered.dependabot.securityUpdatesEnabled, true);
    assert.equal(covered.alerts.counts.high, 1);
    assert.equal(covered.alerts.list[0].patchedVersion, '4.17.21');
    assert.equal(covered.prs.counts.dependabot, 1);
    assert.equal(covered.prs.counts.other, 1);
    assert.equal(covered.prs.dependabot[0].checks.state, 'passing');
    assert.equal(covered.prs.other[0].checks.state, 'failing');
    assert.equal(covered.lastScan.source, 'dependabot-run');

    const naked = state.repos.find(r => r.fullName === 'me/naked');
    assert.equal(naked.dependabot.configPresent, false);
    assert.equal(naked.dependabot.alertsEnabled, false);
    assert.match(naked.dependabot.alertsError, /disabled/i);
    assert.equal(naked.lastScan.source, 'none');
    assert.ok(naked.gaps.some(g => g.id === 'alerts-disabled'));

    // Rollups the UI depends on
    assert.equal(state.summary.coverage.percent, 50);
    assert.deepEqual(state.summary.coverage.noConfig, ['me/naked']);
    assert.equal(state.summary.prs.dependabot, 1);
    assert.equal(state.summary.prs.other, 1);

    // Read models
    assert.equal(collector.getRepos({ filter: 'no-dependabot' }).length, 1);
    assert.equal(collector.getPullRequests({ kind: 'dependabot' }).length, 1);
    assert.equal(collector.getAlerts({ severity: 'high' }).length, 1);
    assert.equal(collector.getCoverageGaps()[0].fullName, 'me/naked');

    // "Last scan" reads Dependabot's own update jobs, not just any workflow run
    assert.ok(seen.dependabotRunEvents.length > 0);
    assert.ok(seen.dependabotRunEvents.every(e => e === 'dynamic'));

    // Cache survives a restart
    assert.ok(fs.existsSync(cacheFile));
    const reloaded = new Collector(config, { fetchImpl: fakeGitHub().fetchImpl });
    assert.equal(reloaded.state.repos.length, 2);
    assert.equal(reloaded.getStatus().repoCount, 2);

    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('ignores query params that name inherited Object properties', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghtest-'));
    const config = loadConfig({ GITHUB_TOKEN: 'x', GH_CACHE_FILE: path.join(cacheDir, 'cache.json'), GH_HISTORY_FILE: path.join(cacheDir, 'history.jsonl'), GH_AUTO_REFRESH: 'false' });
    const collector = new Collector(config, { fetchImpl: fakeGitHub().fetchImpl, now: () => NOW });
    await collector.refresh();

    const all = collector.getRepos({ filter: 'all' });
    // `filters.constructor` on a plain object would be Object — truthy for every
    // repo — and `sorters.toString` would be used as a comparator.
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const filtered = collector.getRepos({ filter: key });
      assert.equal(filtered.length, all.length, `filter=${key} should be ignored, not applied`);
      const sorted = collector.getRepos({ sort: key });
      assert.deepEqual(sorted.map(r => r.fullName), all.map(r => r.fullName), `sort=${key} should fall back to risk`);
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    let userCalls = 0;
    const { fetchImpl: inner } = fakeGitHub();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghtest-'));
    const config = loadConfig({ GITHUB_TOKEN: 'x', GH_CACHE_FILE: path.join(cacheDir, 'cache.json'), GH_HISTORY_FILE: path.join(cacheDir, 'history.jsonl'), GH_AUTO_REFRESH: 'false' });
    const collector = new Collector(config, {
      fetchImpl: async (url, opts) => {
        if (new URL(url).pathname === '/user') userCalls++;
        return inner(url, opts);
      }
    });
    await Promise.all([collector.refresh(), collector.refresh(), collector.refresh()]);
    assert.equal(userCalls, 1);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('keeps healthy repos when one repo blows up mid-collection', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghtest-'));
    const config = loadConfig({ GITHUB_TOKEN: 'x', GH_CACHE_FILE: path.join(cacheDir, 'cache.json'), GH_HISTORY_FILE: path.join(cacheDir, 'history.jsonl'), GH_AUTO_REFRESH: 'false' });
    const { fetchImpl: inner } = fakeGitHub();
    const collector = new Collector(config, {
      now: () => NOW,
      fetchImpl: async (url, opts) => {
        // A malformed listing entry: no full_name, so posture building throws.
        if (new URL(url).pathname === '/user/repos') {
          const res = await inner(url, opts);
          const repos = await res.json();
          return fakeResponse({ body: [...repos, { name: 'broken' }] });
        }
        return inner(url, opts);
      }
    });

    const state = await collector.refresh();
    assert.equal(state.repos.length, 2, 'the two good repos still land');
    assert.ok(state.fetchedAt, 'state was still committed');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
});
