const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { loadConfig } = require('../lib/config');
const posture = require('../lib/posture');
const { History, snapshot } = require('../lib/history');
const { verifySignature, planForEvent } = require('../lib/webhook');
const { Collector, normalizeSbomPackages, buildPackageIndex } = require('../lib/collector');

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const ago = days => new Date(NOW - days * DAY).toISOString();

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pbfeat-'));

// Anything that builds a Collector must write its cache and history somewhere
// disposable — the defaults point at the checkout's own .cache directory.
const SCRATCH = tmpdir();
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
const scratchEnv = (extra = {}) => ({
  GITHUB_TOKEN: 'x',
  GH_AUTO_REFRESH: 'false',
  GH_CACHE_FILE: path.join(SCRATCH, 'cache.json'),
  GH_HISTORY_FILE: path.join(SCRATCH, 'history.jsonl'),
  ...extra
});

// === age budgets (SLA) ===================================================

describe('severity age budgets', () => {
  const alert = (severity, days) => ({
    number: 1,
    security_advisory: { summary: `${severity} thing`, ghsa_id: `GHSA-${severity}` },
    security_vulnerability: { severity, package: { name: 'pkg', ecosystem: 'npm' } },
    created_at: ago(days)
  });

  it('marks an alert older than its severity budget as breached', () => {
    const built = posture.buildRepoPosture({
      repo: { full_name: 'me/app', name: 'app', owner: { login: 'me' } },
      alerts: [alert('critical', 10), alert('critical', 2), alert('low', 10)]
    }, { now: NOW, sla: { critical: 7, high: 30, medium: 90, low: 180 } });

    const breached = built.alerts.list.filter(a => a.breachesSla);
    assert.equal(breached.length, 1);
    assert.equal(breached[0].ageDays, 10);
    assert.equal(built.alerts.slaBreaches, 1);
    // The budget itself travels with the alert so the UI can explain the flag.
    assert.equal(built.alerts.list[0].slaDays, 7);
  });

  it('raises the sla-breach gap and leads the recommended action with it', () => {
    const built = posture.buildRepoPosture({
      repo: { full_name: 'me/app', name: 'app', owner: { login: 'me' } },
      alerts: [alert('medium', 200)],
      config: { present: true, ecosystems: ['npm'] },
      alertsEnabled: true
    }, { now: NOW });

    assert.ok(built.gaps.some(g => g.id === 'sla-breach'), 'expected an sla-breach gap');
    assert.match(built.action.text, /past budget/i);
  });

  it('treats a zero-day budget as "no grace" rather than "no budget"', () => {
    const built = posture.buildRepoPosture({
      repo: { full_name: 'me/app', name: 'app', owner: { login: 'me' } },
      alerts: [alert('critical', 1)]
    }, { now: NOW, sla: { critical: 0, high: 30, medium: 90, low: 180 } });
    assert.equal(built.alerts.list[0].breachesSla, true);
  });
});

// === advisory pivot ======================================================

describe('groupByAdvisory', () => {
  const repoWith = (fullName, alerts) => ({ fullName, alerts: { list: alerts } });
  const a = (over = {}) => ({
    ghsaId: 'GHSA-lodash', cveId: 'CVE-2026-1', severity: 'high',
    summary: 'Prototype pollution', package: 'lodash', ecosystem: 'npm',
    patchedVersion: '4.17.21', url: 'https://example.test/1', manifest: 'package.json',
    ageDays: 5, breachesSla: false, ...over
  });

  it('collapses the same advisory across repos into one row', () => {
    const grouped = posture.groupByAdvisory([
      repoWith('me/one', [a({ ageDays: 5 })]),
      repoWith('me/two', [a({ ageDays: 40, breachesSla: true })]),
      repoWith('me/three', [a({ ageDays: 12 })])
    ]);

    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].repoCount, 3);
    assert.equal(grouped[0].oldestDays, 40);
    assert.equal(grouped[0].breaches, 1);
    assert.deepEqual(grouped[0].repos.map(r => r.repo), ['me/one', 'me/two', 'me/three']);
  });

  it('sorts by severity, then blast radius, then age', () => {
    const grouped = posture.groupByAdvisory([
      repoWith('me/one', [
        a({ ghsaId: 'GHSA-a', severity: 'high', package: 'a' }),
        a({ ghsaId: 'GHSA-b', severity: 'critical', package: 'b' }),
        a({ ghsaId: 'GHSA-c', severity: 'high', package: 'c' })
      ]),
      repoWith('me/two', [a({ ghsaId: 'GHSA-c', severity: 'high', package: 'c' })])
    ]);

    assert.deepEqual(grouped.map(g => g.package), ['b', 'c', 'a']);
  });

  it('falls back to package+summary when an advisory has no identifier', () => {
    const grouped = posture.groupByAdvisory([
      repoWith('me/one', [a({ ghsaId: null, cveId: null })]),
      repoWith('me/two', [a({ ghsaId: null, cveId: null })])
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].repoCount, 2);
  });

  it('keeps distinct advisories for the same package apart', () => {
    const grouped = posture.groupByAdvisory([
      repoWith('me/one', [a({ ghsaId: 'GHSA-a' }), a({ ghsaId: 'GHSA-b' })])
    ]);
    assert.equal(grouped.length, 2);
  });
});

// === SBOM / package index ================================================

describe('SBOM package index', () => {
  it('normalizes SPDX package names into ecosystem + name', () => {
    const out = normalizeSbomPackages([
      { name: 'npm:lodash', versionInfo: '4.17.20' },
      { name: 'pip:requests', versionInfo: '2.31.0' },
      { name: 'actions:actions/checkout', versionInfo: '4' },
      { name: 'com.github.me/app', versionInfo: '1' },
      { name: 'bare-name', versionInfo: '2' },
      { name: '', versionInfo: '9' }
    ]);

    const byName = Object.fromEntries(out.map(p => [p.name, p]));
    assert.equal(byName.lodash.ecosystem, 'npm');
    assert.equal(byName.lodash.version, '4.17.20');
    assert.equal(byName.requests.ecosystem, 'pip');
    assert.equal(byName['actions/checkout'].ecosystem, 'actions');
    // The repo's own SPDX describes-package is noise, not a dependency.
    assert.equal(out.some(p => p.name.startsWith('com.github.')), false);
    // A name with no ecosystem prefix still counts, it just has no ecosystem.
    assert.ok(byName['bare-name']);
    assert.equal(out.some(p => !p.name), false);
  });

  it('prefers the purl in externalRefs over the display name', () => {
    const out = normalizeSbomPackages([
      {
        name: 'go:github.com/spf13/cobra', versionInfo: '1.8.0',
        externalRefs: [
          { referenceType: 'other', referenceLocator: 'ignore-me' },
          { referenceType: 'purl', referenceLocator: 'pkg:golang/github.com/spf13/cobra@1.8.0' }
        ]
      },
      // Scoped npm names arrive percent-encoded in a purl.
      { name: 'npm:whatever', versionInfo: '1', externalRefs: [{ referenceType: 'purl', referenceLocator: 'pkg:npm/%40scope/thing@2.0.0' }] },
      // An unparseable purl falls back to the name.
      { name: 'npm:fallback', versionInfo: '3', externalRefs: [{ referenceType: 'purl', referenceLocator: 'not-a-purl' }] }
    ]);

    assert.deepEqual(out, [
      { ecosystem: 'golang', name: 'github.com/spf13/cobra', version: '1.8.0' },
      { ecosystem: 'npm', name: '@scope/thing', version: '1' },
      { ecosystem: 'npm', name: 'fallback', version: '3' }
    ]);
  });

  it('caps how many packages one repo can contribute', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `npm:p${i}`, versionInfo: '1' }));
    assert.equal(normalizeSbomPackages(many, 10).length, 10);
  });

  it('survives a malformed SBOM', () => {
    assert.deepEqual(normalizeSbomPackages(null), []);
    assert.deepEqual(normalizeSbomPackages([null, 5, {}]), []);
  });

  it('indexes packages by ecosystem:name across repos', () => {
    const index = buildPackageIndex(new Map([
      ['me/one', [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, { ecosystem: 'npm', name: 'express', version: '4.21.0' }]],
      ['me/two', [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }]],
      ['me/three', [{ ecosystem: 'pip', name: 'lodash', version: '0.1' }]]
    ]));

    assert.equal(index.repoCount, 3);
    // npm:lodash and pip:lodash are different packages that happen to share a name.
    assert.equal(index.count, 3);
    const npmLodash = index.entries.find(e => e.key === 'npm:lodash');
    assert.equal(npmLodash.repos.length, 2);
    assert.deepEqual(npmLodash.repos.map(r => r.version), ['4.17.20', '4.17.21']);
  });
});

// === history =============================================================

describe('history', () => {
  const state = (overrides = {}) => ({
    repos: [
      { fullName: 'me/one', alerts: { counts: { total: 3 } } },
      { fullName: 'me/two', alerts: { counts: { total: 0 } } }
    ],
    summary: {
      activeCount: 2,
      coverage: { percent: 50, noConfig: ['me/two'], staleScans: [] },
      alerts: { critical: 1, high: 2, medium: 0, low: 0, total: 3 },
      prs: { dependabot: 1, other: 2 }
    },
    ...overrides
  });

  it('reduces a state to a snapshot row', () => {
    const row = snapshot(state(), '2026-06-01T00:00:00Z');
    assert.equal(row.repos, 2);
    assert.equal(row.coverage, 50);
    assert.equal(row.critical, 1);
    assert.equal(row.alerts, 3);
    assert.equal(row.noConfig, 1);
    assert.deepEqual(row.byRepo, { 'me/one': 3, 'me/two': 0 });
  });

  it('appends and reads back rows inside the retention window', () => {
    const dir = tmpdir();
    const history = new History({ file: path.join(dir, 'h.jsonl'), retentionDays: 30 });
    history.append({ at: new Date(Date.now() - 60 * DAY).toISOString(), alerts: 9 });
    history.append({ at: new Date().toISOString(), alerts: 4 });

    const rows = history.read();
    assert.equal(rows.length, 1, 'the expired row should be filtered out on read');
    assert.equal(rows[0].alerts, 4);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads an empty history for a file that does not exist', () => {
    const history = new History({ file: path.join(tmpdir(), 'missing', 'h.jsonl') });
    assert.deepEqual(history.read(), []);
    assert.equal(history.changesSince(new Date().toISOString()), null);
  });

  it('ignores a torn final line instead of losing the whole file', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'h.jsonl');
    const good = JSON.stringify({ at: new Date().toISOString(), alerts: 2 });
    fs.writeFileSync(file, `${good}\n{"at":"2026-`);
    assert.equal(new History({ file }).read().length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('diffs the latest snapshot against the one before a given time', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'h.jsonl');
    const history = new History({ file });
    const rows = [
      { at: new Date(Date.now() - 10 * DAY).toISOString(), critical: 3, high: 1, alerts: 6, dependabotPrs: 4, coverage: 40, byRepo: { 'me/one': 5, 'me/two': 1 } },
      { at: new Date(Date.now() - 5 * DAY).toISOString(), critical: 2, high: 1, alerts: 5, dependabotPrs: 3, coverage: 50, byRepo: { 'me/one': 4, 'me/two': 1 } },
      { at: new Date().toISOString(), critical: 1, high: 3, alerts: 4, dependabotPrs: 2, coverage: 60, byRepo: { 'me/one': 2, 'me/two': 2 } }
    ];
    for (const row of rows) history.append(row);

    const changes = history.changesSince(new Date(Date.now() - 6 * DAY).toISOString());
    assert.equal(changes.critical, -2);
    assert.equal(changes.high, 2);
    assert.equal(changes.coverage, 20);
    // Biggest increase first, so the banner names what got worse.
    assert.deepEqual(changes.repos, [
      { repo: 'me/two', before: 1, after: 2, delta: 1 },
      { repo: 'me/one', before: 5, after: 2, delta: -3 }
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns no changes when the baseline is the latest row', () => {
    const dir = tmpdir();
    const history = new History({ file: path.join(dir, 'h.jsonl') });
    history.append({ at: new Date(Date.now() - DAY).toISOString(), critical: 1, byRepo: {} });
    history.append({ at: new Date().toISOString(), critical: 1, byRepo: {} });
    assert.equal(history.changesSince(new Date(Date.now() + DAY).toISOString()), null);
    assert.equal(history.changesSince('not a date'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('extracts a per-repo series for sparklines', () => {
    const dir = tmpdir();
    const history = new History({ file: path.join(dir, 'h.jsonl') });
    history.append({ at: new Date(Date.now() - DAY).toISOString(), byRepo: { 'me/one': 4 } });
    history.append({ at: new Date().toISOString(), byRepo: { 'me/one': 2, 'me/two': 7 } });

    assert.deepEqual(history.seriesFor('me/one').map(p => p.value), [4, 2]);
    // A repo missing from a snapshot contributes no point rather than a zero.
    assert.deepEqual(history.seriesFor('me/two').map(p => p.value), [7]);
    assert.deepEqual(history.seriesFor('me/nope'), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// === webhook =============================================================

describe('webhook', () => {
  const sign = (body, secret) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a correctly signed body', () => {
    const body = Buffer.from('{"zen":"hi"}');
    assert.equal(verifySignature(body, sign(body, 's3cret'), 's3cret'), true);
  });

  it('rejects wrong secrets, tampered bodies and malformed signatures', () => {
    const body = Buffer.from('{"zen":"hi"}');
    assert.equal(verifySignature(body, sign(body, 'other'), 's3cret'), false);
    assert.equal(verifySignature(Buffer.from('{"zen":"ho"}'), sign(body, 's3cret'), 's3cret'), false);
    // A short signature must not throw out of timingSafeEqual.
    assert.equal(verifySignature(body, 'sha256=beef', 's3cret'), false);
    assert.equal(verifySignature(body, '', 's3cret'), false);
    assert.equal(verifySignature(body, sign(body, 's3cret'), ''), false);
    // A string body would hash differently than the bytes GitHub signed.
    assert.equal(verifySignature('{"zen":"hi"}', sign(body, 's3cret'), 's3cret'), false);
  });

  it('plans a re-collect for events that change a repo posture', () => {
    const payload = { repository: { full_name: 'me/app' }, action: 'created' };
    for (const event of ['dependabot_alert', 'pull_request', 'code_scanning_alert', 'secret_scanning_alert']) {
      const plan = planForEvent(event, payload);
      assert.equal(plan.action, 'recollect', event);
      assert.equal(plan.repo, 'me/app');
    }
  });

  it('acks a ping, ignores noise and drops deleted repos', () => {
    assert.equal(planForEvent('ping', { zen: 'hi' }).action, 'ack');
    assert.equal(planForEvent('star', { repository: { full_name: 'me/app' } }).action, 'ignore');
    assert.equal(planForEvent('dependabot_alert', {}).action, 'ignore');
    const dropped = planForEvent('repository', { repository: { full_name: 'me/app' }, action: 'deleted' });
    assert.equal(dropped.action, 'drop');
    assert.equal(dropped.repo, 'me/app');
  });

  it('refuses to act on a repository name that is not owner/repo', () => {
    // The name becomes a request path and a log line, so a payload that smuggles
    // a traversal, a query string or a newline must not get that far.
    const bad = [
      'me/app/../../admin', '../etc/passwd', 'me/app?x=1', 'me/app\nINFO fake log line',
      'me app', 'noslash', 'me/', '/app', '', 42, { full_name: 'me/app' },
      `me/${'a'.repeat(200)}`
    ];
    for (const full_name of bad) {
      const plan = planForEvent('dependabot_alert', { repository: { full_name }, action: 'created' });
      assert.equal(plan.action, 'ignore', `should ignore ${JSON.stringify(full_name)}`);
      assert.equal(plan.repo, undefined);
    }
    // The shapes GitHub actually sends still pass.
    for (const full_name of ['me/app', 'my-org/my.repo', 'a/b', 'me/audit-dashboard']) {
      assert.equal(planForEvent('dependabot_alert', { repository: { full_name } }).repo, full_name);
    }
  });
});

// === merge guardrails ====================================================

describe('mergePullRequest', () => {
  const collectorWith = (env, fetchImpl) =>
    new Collector(loadConfig(scratchEnv(env)), { fetchImpl });

  it('refuses to merge at all when writes are disabled', async () => {
    let called = false;
    const collector = collectorWith({}, async () => { called = true; });
    await assert.rejects(
      () => collector.mergePullRequest({ repo: 'me/app', number: 1 }),
      err => err.status === 403 && /GH_ALLOW_WRITES/.test(err.message)
    );
    assert.equal(called, false, 'no request should reach GitHub');
  });

  it('rejects repo names and PR numbers that are not what they claim to be', async () => {
    const collector = collectorWith({ GH_ALLOW_WRITES: 'true' }, async () => {
      throw new Error('should not be called');
    });
    const bad = [
      { repo: 'me/app/../../admin', number: 1 },
      { repo: '../etc/passwd', number: 1 },
      { repo: 'me/app?x=1', number: 1 },
      { repo: '', number: 1 },
      { repo: 'me/app', number: 0 },
      { repo: 'me/app', number: -3 },
      { repo: 'me/app', number: '1; rm -rf /' },
      { repo: 'me/app', number: 1.5 }
    ];
    for (const args of bad) {
      await assert.rejects(() => collector.mergePullRequest(args), err => err.status === 400, JSON.stringify(args));
    }
  });

  it('merges with a squash by default and forgets the PR locally', async () => {
    const seen = [];
    const collector = collectorWith({ GH_ALLOW_WRITES: 'true' }, async (url, opts) => {
      seen.push({ url, method: opts.method, body: opts.body });
      return {
        status: 200, ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ merged: true, sha: 'abc123' }),
        text: async () => ''
      };
    });
    const bump = number => ({
      number, title: 'build(deps): bump pkg from 1 to 2', user: { login: 'dependabot[bot]' },
      head: { ref: 'dependabot/npm_and_yarn/pkg-2', sha: `sha${number}` },
      created_at: ago(1), updated_at: ago(1), html_url: `https://example.test/pull/${number}`
    });
    collector.state.repos = [posture.buildRepoPosture({
      repo: { full_name: 'me/app', name: 'app', owner: { login: 'me' } },
      config: { present: true, ecosystems: ['npm'] },
      alertsEnabled: true,
      pulls: [bump(7), bump(8)]
    }, { now: NOW })];

    const result = await collector.mergePullRequest({ repo: 'me/app', number: 7, method: 'rebase' });
    assert.equal(result.merged, true);
    assert.equal(result.sha, 'abc123');
    assert.equal(result.method, 'rebase');
    assert.match(seen[0].url, /\/repos\/me\/app\/pulls\/7\/merge$/);
    assert.equal(seen[0].method, 'PUT');
    assert.deepEqual(collector.state.repos[0].prs.dependabot.map(p => p.number), [8]);

    // An unknown method falls back to squash rather than being passed through.
    await collector.mergePullRequest({ repo: 'me/app', number: 8, method: 'force-push' });
    const sent = typeof seen[1].body === 'string' ? JSON.parse(seen[1].body) : seen[1].body;
    assert.equal(sent.merge_method, 'squash');
  });
});

// === partial updates (the webhook path) ==================================

describe('single-repo updates', () => {
  const withRepos = () => {
    const c = new Collector(loadConfig(scratchEnv()), { fetchImpl: async () => {} });
    c.state.repos = ['me/one', 'me/two'].map(fullName => posture.buildRepoPosture({
      repo: { full_name: fullName, name: fullName.split('/')[1], owner: { login: 'me' } },
      config: { present: true, ecosystems: ['npm'] },
      alertsEnabled: true
    }, { now: NOW }));
    c.packagesByRepo = new Map([['me/one', [{ ecosystem: 'npm', name: 'lodash', version: '1' }]]]);
    c.state.summary = posture.summarize(c.state.repos, { staleDays: 14 });
    return c;
  };

  it('drops a deleted repo from the state, its packages and the rollup', () => {
    const c = withRepos();
    assert.equal(c.dropRepo('me/one'), true);
    assert.deepEqual(c.state.repos.map(r => r.fullName), ['me/two']);
    assert.equal(c.packagesByRepo.has('me/one'), false);
    assert.equal(c.state.summary.activeCount, 1);
  });

  it('reports a no-op for a repo it never knew about', () => {
    const c = withRepos();
    assert.equal(c.dropRepo('me/never-heard-of-it'), false);
    assert.equal(c.state.repos.length, 2);
  });
});

// === read models =========================================================

describe('collector read models', () => {
  const collector = () => {
    const c = new Collector(loadConfig(scratchEnv()), { fetchImpl: async () => {} });
    c.state.advisories = [
      { id: 'a', severity: 'critical', package: 'a', repoCount: 1 },
      { id: 'b', severity: 'high', package: 'b', repoCount: 3 },
      { id: 'c', severity: 'low', package: 'c', repoCount: 2 }
    ];
    c.state.packageIndex = buildPackageIndex(new Map([
      ['me/one', [{ ecosystem: 'npm', name: 'lodash', version: '1' }, { ecosystem: 'npm', name: 'lodash.merge', version: '2' }]],
      ['me/two', [{ ecosystem: 'npm', name: 'lodash', version: '1' }]]
    ]));
    return c;
  };

  it('filters advisories by severity and blast radius', () => {
    const c = collector();
    assert.equal(c.getAdvisories().length, 3);
    assert.deepEqual(c.getAdvisories({ severity: 'high' }).map(a => a.id), ['b']);
    assert.deepEqual(c.getAdvisories({ minRepos: 2 }).map(a => a.id), ['b', 'c']);
  });

  it('ranks exact package matches above substring matches', () => {
    const results = collector().searchPackages('lodash').results;
    assert.deepEqual(results.map(r => r.name), ['lodash', 'lodash.merge']);
    assert.equal(results[0].repos.length, 2);
  });

  it('reports totals but no results for an empty query', () => {
    const out = collector().searchPackages('');
    assert.equal(out.indexed, true);
    assert.equal(out.count, 2);
    assert.deepEqual(out.results, []);
  });

  it('says so when nothing has been indexed', () => {
    const c = new Collector(loadConfig(scratchEnv()), { fetchImpl: async () => {} });
    assert.deepEqual(c.searchPackages('lodash'), { count: 0, repoCount: 0, results: [], indexed: false });
  });
});
