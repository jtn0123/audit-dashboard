const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { loadConfig } = require('../lib/config');
const posture = require('../lib/posture');
const { History, snapshot } = require('../lib/history');
const { Collector, normalizeSbomPackages, buildPackageIndex } = require('../lib/collector');

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const ago = days => new Date(NOW - days * DAY).toISOString();

it('changes include added and removed repositories', () => {
  const { changesSince } = require('../lib/history-views');
  const row = { critical: 0, high: 0, alerts: 0, dependabotPrs: 0 };
  const changes = changesSince([
    { ...row, at: ago(2), byRepo: { 'me/removed': 3, 'me/unchanged': 1 } },
    { ...row, at: ago(0), byRepo: { 'me/added': 2, 'me/unchanged': 1 } }
  ], ago(1));
  assert.deepEqual(changes.repos, [
    { repo: 'me/added', before: 0, after: 2, delta: 2 },
    { repo: 'me/removed', before: 3, after: 0, delta: -3 }
  ]);
});

it('OpenAPI exposes every new repository filter', () => {
  const { spec } = require('../lib/openapi');
  const filters = spec.paths['/api/gh/repos'].get.parameters.find(p => p.name === 'filter').schema.enum;
  for (const filter of ['sla', 'secrets', 'ci-failing']) assert.ok(filters.includes(filter));
});

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

  it('counts unique repositories while retaining each affected manifest', () => {
    const [group] = posture.groupByAdvisory([
      repoWith('me/one', [a(), a({ manifest: 'web/package.json' })])
    ]);
    assert.equal(group.repoCount, 1);
    assert.equal(group.repos.length, 2);
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
    assert.deepEqual(normalizeSbomPackages([{ name: 5, externalRefs: {} }, { externalRefs: [null] }]), []);
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

  it('migrates a legacy history containing only one complete JSONL row', () => {
    const file = path.join(SCRATCH, 'single-row.jsonl');
    fs.writeFileSync(file, JSON.stringify({ at: new Date(NOW).toISOString(), alerts: 4, byRepo: { 'me/one': 4 } }) + '\n');
    const history = new History({ file, now: () => NOW });
    assert.equal(history.read().length, 1);
    assert.equal(history.read()[0].alerts, 4);
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

// === read models =========================================================

describe('collector read models', () => {
  it('distinguishes unavailable SBOMs from a successful empty graph', async () => {
    const c = new Collector(loadConfig(scratchEnv()), { fetchImpl: async () => {} });
    for (const data of [null, {}, { sbom: { packages: 'invalid' } }]) {
      c.client.get = async () => data;
      assert.equal(await c.fetchPackages('me/app', []), null);
    }
    c.client.get = async () => { throw new Error('unavailable'); };
    const errors = [];
    assert.equal(await c.fetchPackages('me/app', errors), null);
    assert.equal(errors[0].scope, 'sbom');
    c.client.get = async () => ({ sbom: { packages: [] } });
    assert.deepEqual(await c.fetchPackages('me/app', []), []);
  });

  it('only marks complete enabled SBOM collection as indexed', async () => {
    const c = new Collector(loadConfig(scratchEnv()), { fetchImpl: async () => {} });
    c.client.get = async () => ({ login: 'me' });
    const selected = [{ full_name: 'me/app', name: 'app' }];
    c.discoverRepos = async () => selected;
    let indexed = false;
    c.collectRepo = async repo => {
      if (indexed) c.packagesByRepo.set(repo.full_name, []);
      return posture.buildRepoPosture({ repo }, { now: NOW });
    };
    await c.refresh();
    assert.equal(c.searchPackages('').indexed, false);
    indexed = true;
    await c.refresh();
    assert.equal(c.searchPackages('').indexed, true);
    c.config.collectSbom = false;
    await c.refresh();
    assert.equal(c.searchPackages('').indexed, false);
    c.config.collectSbom = true;
    c.discoverRepos = async () => [];
    await c.refresh();
    assert.equal(c.searchPackages('').indexed, false);
  });

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
    const c = collector();
    c.state.packageIndex.entries.find(e => e.name === 'lodash.merge').repos.push(
      { repo: 'me/three' }, { repo: 'me/four' }, { repo: 'me/five' }
    );
    const results = c.searchPackages('lodash').results;
    assert.deepEqual(results.map(r => r.name), ['lodash', 'lodash.merge']);
    assert.equal(results[0].repos.length, 2);
  });

  it('finds an exact match after more than 500 partial matches', () => {
    const c = collector();
    c.state.packageIndex.entries = Array.from({ length: 501 }, (_, i) => ({ name: `aaa-${i}-lodash`, repos: [] }));
    c.state.packageIndex.entries.push({ name: 'lodash', repos: [] });
    assert.equal(c.searchPackages('lodash', { limit: 1 }).results[0].name, 'lodash');
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
