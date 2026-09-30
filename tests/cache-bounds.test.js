'use strict';

// Regression tests for the 2026-09 production outage: the persisted ETag
// cache stored whole GitHub response bodies with only an entry-count cap, so
// per-commit check-run bodies (~100 KB each, one new key per push) and full
// PR lists grew github.json to 98 MB. Parsing that on boot exceeded the
// container's 512 MB limit, and the container was OOM-killed on every start
// for 24 days (24,802 restarts). Each test pins one of the bounds that now
// prevents it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GitHubClient, pruneEtags } = require('../lib/github');
const { Collector, slimPulls, slimCheckRuns, slimPrFiles } = require('../lib/collector');
const { loadConfig } = require('../lib/config');

const MB = 1048576;

function fakeResponse({ status = 200, body = {}, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) },
    json: async () => body
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cache-bounds-'));
}

// Roughly the size of the real objects: GitHub embeds the full repo in a PR's
// head and base, and a check run carries its output text and app metadata.
const PADDING = 'x'.repeat(20_000);
function fatPull(number, sha) {
  return {
    number, title: `bump dep-${number} from 1.0.0 to 1.0.1`, html_url: `https://github.com/me/app/pull/${number}`,
    state: 'open', draft: false, created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-02T00:00:00Z', merged_at: null,
    user: { login: 'dependabot[bot]', type: 'Bot', avatar_url: PADDING },
    head: { ref: `dependabot/npm_and_yarn/dep-${number}`, sha, repo: { description: PADDING } },
    base: { ref: 'main', repo: { description: PADDING } },
    labels: [{ name: 'dependencies', description: PADDING }],
    body: PADDING
  };
}
function fatCheckRuns() {
  return {
    total_count: 5,
    check_runs: Array.from({ length: 5 }, (_, i) => ({
      name: `check-${i}`, status: 'completed', conclusion: 'success',
      output: { text: PADDING }, app: { description: PADDING }
    }))
  };
}

describe('pruneEtags bounds', () => {
  const entry = (usedAt, bytes = 10) => ({ etag: '"e"', data: 'y'.repeat(bytes), usedAt });

  it('drops entries unused for longer than maxAgeMs', () => {
    const now = 10 * 86_400_000;
    const etags = { live: entry(now - 1000), dead: entry(now - 5 * 86_400_000) };
    pruneEtags(etags, { maxAgeMs: 3 * 86_400_000, now });
    assert.deepEqual(Object.keys(etags), ['live']);
  });

  it('evicts least recently used first until under maxBytes', () => {
    const etags = {};
    for (let i = 0; i < 20; i++) etags[`k${i}`] = entry(i, 10_000);
    pruneEtags(etags, { maxBytes: 50_000 });
    const kept = Object.keys(etags);
    const bytes = kept.reduce((n, k) => n + k.length + JSON.stringify(etags[k]).length, 0);
    assert.ok(bytes <= 50_000, `kept ${bytes} bytes`);
    assert.ok(kept.length >= 4, 'budget should still hold several entries');
    assert.ok(kept.includes('k19'), 'most recently used entry must survive');
    assert.ok(!kept.includes('k0'), 'least recently used entry must go first');
  });

  it('still honours the entry cap', () => {
    const etags = {};
    for (let i = 0; i < 10; i++) etags[`k${i}`] = entry(i);
    pruneEtags(etags, { maxEntries: 3 });
    assert.deepEqual(Object.keys(etags).sort(), ['k7', 'k8', 'k9']);
  });
});

describe('response projection', () => {
  it('caches and returns only the projected body', async () => {
    const etags = {};
    const client = new GitHubClient({
      token: 't', etags,
      fetchImpl: async () => fakeResponse({ body: [fatPull(1, 'aaa')], headers: { etag: '"1"' } })
    });
    const data = await client.get('/repos/me/app/pulls', { project: slimPulls });
    assert.equal(data[0].head.sha, 'aaa');
    assert.equal(data[0].body, undefined);
    const stored = JSON.stringify(etags);
    assert.ok(!stored.includes(PADDING), 'padding must not reach the cache');
  });

  it('re-projects a body cached whole by an older build on 304', async () => {
    const key = 'GET https://api.github.com/repos/me/app/commits/abc/check-runs';
    const etags = { [key]: { etag: '"1"', data: fatCheckRuns(), nextUrl: null, usedAt: 1 } };
    const client = new GitHubClient({ token: 't', etags, fetchImpl: async () => fakeResponse({ status: 304 }) });
    const data = await client.get('/repos/me/app/commits/abc/check-runs', { project: slimCheckRuns });
    assert.equal(data.check_runs.length, 5);
    assert.ok(!JSON.stringify(etags[key]).includes(PADDING));
  });

  it('projections are idempotent and keep the fields the collector reads', () => {
    const once = slimPulls([fatPull(7, 'sha7')]);
    assert.deepEqual(slimPulls(once), once);
    assert.equal(once[0].user.login, 'dependabot[bot]');
    assert.equal(once[0].labels[0].name, 'dependencies');
    const runs = slimCheckRuns(fatCheckRuns());
    assert.deepEqual(slimCheckRuns(runs), runs);
    assert.deepEqual(slimPrFiles(slimPrFiles([{ filename: 'package.json', patch: PADDING }])), [{ filename: 'package.json' }]);
  });
});

describe('persisted cache stays bounded', () => {
  // A repo whose PRs get a new head commit every scan: the churn that minted
  // a fresh, never-reused check-runs key per push in production.
  function churningGitHub() {
    let scan = 0;
    const fetchImpl = async url => {
      const u = new URL(url);
      const p = u.pathname;
      const etag = { etag: `"${p}-${scan}"` };
      if (p === '/user') return fakeResponse({ body: { login: 'me' }, headers: etag });
      if (p === '/user/repos') {
        return fakeResponse({ body: [{ full_name: 'me/app', name: 'app', owner: { login: 'me' }, default_branch: 'main', pushed_at: '2026-05-01T00:00:00Z' }], headers: etag });
      }
      if (p === '/repos/me/app') return fakeResponse({ body: { full_name: 'me/app', name: 'app', owner: { login: 'me' }, default_branch: 'main' }, headers: etag });
      if (p === '/repos/me/app/pulls') {
        const state = u.searchParams.get('state');
        const pulls = Array.from({ length: 15 }, (_, i) => fatPull(i + 1, `sha-${scan}-${i}`));
        if (state === 'closed') pulls.forEach(pr => { pr.merged_at = '2026-05-03T00:00:00Z'; });
        return fakeResponse({ body: pulls, headers: etag });
      }
      if (/\/commits\/[^/]+\/check-runs$/.test(p)) return fakeResponse({ body: fatCheckRuns(), headers: etag });
      if (/\/pulls\/\d+\/files$/.test(p)) return fakeResponse({ body: [{ filename: 'package-lock.json', patch: PADDING }], headers: etag });
      return fakeResponse({ status: 404, body: { message: 'Not Found' } });
    };
    return { fetchImpl, nextScan: () => { scan++; } };
  }

  it('does not grow with every scan when commits churn', async () => {
    const dir = tmpDir();
    try {
      const cacheFile = path.join(dir, 'github.json');
      const config = loadConfig({
        GITHUB_TOKEN: 'x', GH_CACHE_FILE: cacheFile, GH_HISTORY_FILE: path.join(dir, 'history.json'),
        GH_AUTO_REFRESH: 'false', GH_COLLECT_SBOM: 'false'
      });
      const gh = churningGitHub();
      const collector = new Collector(config, { fetchImpl: gh.fetchImpl });
      const sizes = [];
      for (let i = 0; i < 20; i++) {
        gh.nextScan();
        const state = await collector.refresh();
        assert.equal(state.repos.length, 1);
        sizes.push(fs.statSync(cacheFile).size);
      }
      // Unprojected, 20 scans x 15 PRs of these bodies is ~70 MB on disk.
      assert.ok(sizes.at(-1) < 2 * MB, `cache reached ${(sizes.at(-1) / MB).toFixed(1)} MB after 20 scans`);
      assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes(PADDING), 'no unprojected body was persisted');
      // Checks still resolve from the projected bodies.
      const repo = collector.state.repos[0];
      assert.equal(repo.prs.dependabot[0].checks.state, 'passing');
      assert.deepEqual(repo.prs.dependabot[0].files, ['package-lock.json']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('holds the file to the byte budget whatever the bodies', () => {
    const dir = tmpDir();
    try {
      const cacheFile = path.join(dir, 'github.json');
      const collector = new Collector(loadConfig({ GH_CACHE_FILE: cacheFile, GH_CACHE_MAX_MB: '1' }));
      const now = Date.now();
      for (let i = 0; i < 60; i++) {
        collector.etags[`GET https://api.github.com/x/${i}`] = { etag: `"${i}"`, data: 'z'.repeat(100_000), nextUrl: null, usedAt: now - (60 - i) };
      }
      collector.saveCache();
      const size = fs.statSync(cacheFile).size;
      assert.ok(size <= 1.1 * MB, `cache file is ${(size / MB).toFixed(2)} MB with a 1 MB budget`);
      const kept = Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).etags);
      assert.ok(kept.includes('GET https://api.github.com/x/59'), 'newest entry must be kept');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('oversized cache at boot', () => {
  it('sets the file aside unparsed and starts cold instead of crashing', () => {
    const dir = tmpDir();
    try {
      const cacheFile = path.join(dir, 'github.json');
      // Over the 9 MB load limit a 1 MB budget implies. Deliberately not JSON:
      // the guard must decide from the size alone, before any parse.
      fs.writeFileSync(cacheFile, 'not json '.repeat(1_200_000));
      const collector = new Collector(loadConfig({ GH_CACHE_FILE: cacheFile, GH_CACHE_MAX_MB: '1' }));
      assert.equal(collector.state.repos.length, 0);
      assert.deepEqual(Object.keys(collector.etags), []);
      assert.equal(fs.existsSync(cacheFile), false);
      assert.equal(fs.existsSync(`${cacheFile}.oversized`), true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('loads a cache within the limit as before', () => {
    const dir = tmpDir();
    try {
      const cacheFile = path.join(dir, 'github.json');
      fs.writeFileSync(cacheFile, JSON.stringify({ repos: [{ fullName: 'me/app' }], summary: {}, etags: { k: { etag: '"1"', data: 1 } } }));
      const collector = new Collector(loadConfig({ GH_CACHE_FILE: cacheFile, GH_CACHE_MAX_MB: '1' }));
      assert.equal(collector.state.repos.length, 1);
      assert.ok(collector.etags.k.usedAt > 0, 'legacy entries get an age stamp on load');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
