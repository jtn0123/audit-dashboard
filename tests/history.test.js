const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HistoryStore, snapshotFrom, compact, diffSnapshots } = require('../lib/history');
const { buildTimeline, buildCalendar, dayRange } = require('../lib/timeline');

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-15T12:00:00.000Z');

function repo(overrides = {}) {
  return {
    fullName: 'me/app',
    archived: false,
    risk: 10,
    alerts: { counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, list: [] },
    prs: { dependabot: [], other: [], counts: { dependabot: 0, other: 0, stale: 0, drafts: 0, total: 0 } },
    codeScanning: { enabled: true },
    secretScanning: { enabled: true },
    lastScan: { at: null, source: 'none' },
    recentMerges: [],
    gaps: [],
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    fetchedAt: new Date(NOW).toISOString(),
    durationMs: 1200,
    errors: [],
    repos: [repo()],
    summary: {
      repoCount: 1, activeCount: 1, archivedCount: 0,
      alerts: { critical: 1, high: 2, medium: 3, low: 4, total: 10 },
      coverage: { covered: 1, percent: 100, noConfig: [], alertsOff: [], securityUpdatesOff: [], staleScans: [], neverScanned: [] },
      prs: { dependabot: 2, other: 1, stale: 0, total: 3 },
      reposNeedingAttention: 1
    },
    ...overrides
  };
}

describe('snapshotFrom', () => {
  it('reduces a collector state to the charted metrics', () => {
    const s = snapshotFrom(state(), { now: NOW });
    assert.equal(s.day, '2026-08-15');
    assert.equal(s.alerts.total, 10);
    assert.equal(s.coverage.percent, 100);
    assert.equal(s.prs.total, 3);
    assert.equal(s.codeScanning.enabled, 1);
    assert.deepEqual(s.repos, [{ n: 'me/app', r: 10, a: 0, c: 0, h: 0, p: 0 }]);
  });

  it('counts unknown feature flags separately from disabled ones', () => {
    const s = snapshotFrom(state({
      repos: [repo({ codeScanning: { enabled: null } }), repo({ fullName: 'me/b', codeScanning: { enabled: false } })]
    }), { now: NOW });
    assert.deepEqual(s.codeScanning, { enabled: 0, disabled: 1, unknown: 1 });
  });

  it('excludes archived repos from the per-repo series', () => {
    const s = snapshotFrom(state({ repos: [repo(), repo({ fullName: 'me/old', archived: true })] }), { now: NOW });
    assert.deepEqual(s.repos.map(r => r.n), ['me/app']);
  });
});

describe('compact', () => {
  const at = ms => ({ at: new Date(ms).toISOString(), day: new Date(ms).toISOString().slice(0, 10) });

  it('keeps every snapshot inside the fine-grain window', () => {
    const snapshots = [at(NOW - 3600_000), at(NOW - 7200_000), at(NOW)];
    assert.equal(compact(snapshots, { now: NOW }).length, 3);
  });

  it('thins older days down to one snapshot each', () => {
    const old = NOW - 10 * DAY;
    const snapshots = [at(old), at(old + 3600_000), at(old + 7200_000), at(NOW)];
    const kept = compact(snapshots, { now: NOW });
    assert.equal(kept.length, 2);
    assert.equal(kept[0].at, new Date(old + 7200_000).toISOString(), 'keeps the last of that day');
  });

  it('drops anything past the retention horizon', () => {
    const kept = compact([at(NOW - 400 * DAY), at(NOW)], { now: NOW, retentionDays: 180 });
    assert.equal(kept.length, 1);
  });

  it('ignores entries with unparseable timestamps', () => {
    assert.equal(compact([{ at: 'nonsense' }, at(NOW)], { now: NOW }).length, 1);
  });
});

describe('diffSnapshots', () => {
  it('is null without a previous snapshot', () => {
    assert.equal(diffSnapshots(snapshotFrom(state(), { now: NOW }), null), null);
  });

  it('reports per-severity deltas and the repos that moved', () => {
    const before = snapshotFrom(state(), { now: NOW });
    const after = snapshotFrom(state({
      summary: { ...state().summary, alerts: { critical: 0, high: 2, medium: 3, low: 4, total: 9 } },
      repos: [repo({ alerts: { counts: { critical: 0, high: 0, medium: 0, low: 0, total: 4 }, list: [] } })]
    }), { now: NOW });
    const d = diffSnapshots(after, before);
    assert.equal(d.alerts.total, -1);
    assert.equal(d.alerts.critical, -1);
    assert.deepEqual(d.movers[0], { repo: 'me/app', kind: 'worse', alerts: 4, delta: 4 });
  });

  it('marks repos that appeared or vanished between scans', () => {
    const before = snapshotFrom(state(), { now: NOW });
    const after = snapshotFrom(state({ repos: [repo({ fullName: 'me/new' })] }), { now: NOW });
    const kinds = diffSnapshots(after, before).movers.map(m => m.kind);
    assert.ok(kinds.includes('removed'));
  });
});

describe('HistoryStore', () => {
  function tempStore(now = () => NOW) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-history-'));
    return { store: new HistoryStore({ file: path.join(dir, 'history.json'), now }), dir };
  }

  it('persists a snapshot and reloads it', () => {
    const { store, dir } = tempStore();
    store.record(state());
    const reopened = new HistoryStore({ file: path.join(dir, 'history.json'), now: () => NOW });
    assert.equal(reopened.meta.count, 1);
    assert.equal(reopened.meta.since, new Date(NOW).toISOString());
  });

  it('does not double-count a replayed scan', () => {
    const { store } = tempStore();
    store.record(state());
    store.record(state());
    assert.equal(store.meta.count, 1);
  });

  it('survives an unwritable path without throwing', () => {
    // Parent is a regular file, so mkdir fails on every platform (ENOTDIR on
    // Linux, EEXIST on macOS) — what matters is that it fails and is caught.
    // A /proc path would only be unwritable on Linux, making this test mean
    // different things on the machine that wrote it and the one that runs it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-unwritable-'));
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const store = new HistoryStore({ file: path.join(blocker, 'history.json'), now: () => NOW });
    assert.doesNotThrow(() => store.record(state()));
  });

  it('limits list() to the requested window', () => {
    const { store } = tempStore();
    store.record(state({ fetchedAt: new Date(NOW - 40 * DAY).toISOString() }));
    store.record(state());
    assert.equal(store.list({ days: 7 }).length, 1);
    assert.equal(store.list().length, 2);
  });

  it('attaches a delta to every scan but the oldest', () => {
    const { store } = tempStore();
    store.record(state({ fetchedAt: new Date(NOW - DAY).toISOString() }));
    store.record(state());
    const rows = store.timelineWithDeltas({});
    assert.equal(rows.length, 2);
    assert.ok(rows[0].delta, 'newest has a delta');
    assert.equal(rows[1].delta, null, 'oldest has none');
  });
});

describe('buildTimeline', () => {
  const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();

  it('returns one bucket per day, oldest first, ending today', () => {
    const t = buildTimeline([], { days: 30, now: NOW });
    assert.equal(t.days.length, 30);
    assert.equal(t.days[29], '2026-08-15');
    assert.ok(t.days[0] < t.days[29]);
  });

  it('accumulates open alerts into a rising backlog', () => {
    const repos = [repo({
      alerts: {
        counts: {},
        list: [
          { severity: 'high', createdAt: iso(10), package: 'a', summary: 's', url: 'u' },
          { severity: 'high', createdAt: iso(5), package: 'b', summary: 's', url: 'u' }
        ]
      }
    })];
    const t = buildTimeline(repos, { days: 30, now: NOW });
    assert.equal(t.backlog.total[t.days.length - 1], 2);
    assert.equal(t.backlog.total[0], 0);
    assert.equal(t.totals.raised, 2);
  });

  it('counts alerts older than the window as a baseline, not zero', () => {
    const repos = [repo({
      alerts: { counts: {}, list: [{ severity: 'medium', createdAt: iso(400), package: 'a', summary: 's', url: 'u' }] }
    })];
    const t = buildTimeline(repos, { days: 30, now: NOW });
    assert.equal(t.baseline.alerts.total, 1);
    assert.equal(t.backlog.total[0], 1, 'the series starts at the baseline');
    assert.equal(t.totals.raised, 0, 'but it was not raised inside the window');
  });

  it('buckets merged pull requests by merge date', () => {
    const repos = [repo({ recentMerges: [{ number: 1, title: 'bump', url: 'u', kind: 'dependabot', mergedAt: iso(2) }] })];
    const t = buildTimeline(repos, { days: 30, now: NOW });
    assert.equal(t.totals.merges, 1);
    assert.equal(t.merges[t.days.length - 3], 1);
  });

  it('ignores archived repos entirely', () => {
    const repos = [repo({
      archived: true,
      alerts: { counts: {}, list: [{ severity: 'critical', createdAt: iso(1), package: 'a', summary: 's', url: 'u' }] }
    })];
    assert.equal(buildTimeline(repos, { days: 30, now: NOW }).totals.raised, 0);
  });

  it('tolerates missing and malformed dates', () => {
    const repos = [repo({
      alerts: { counts: {}, list: [{ severity: 'low', createdAt: null }, { severity: 'low', createdAt: 'not-a-date' }] }
    })];
    assert.doesNotThrow(() => buildTimeline(repos, { days: 7, now: NOW }));
  });
});

describe('buildCalendar', () => {
  it('produces one cell per day with detail lists attached', () => {
    const repos = [repo({
      alerts: {
        counts: {},
        list: [{ severity: 'high', createdAt: new Date(NOW - DAY).toISOString(), package: 'lodash', summary: 'RCE', url: 'u' }]
      }
    })];
    const cal = buildCalendar(repos, { days: 14, now: NOW });
    assert.equal(cal.cells.length, 14);
    const yesterday = cal.cells[12];
    assert.equal(yesterday.raised, 1);
    assert.equal(yesterday.high, 1);
    assert.equal(yesterday.alerts[0].package, 'lodash');
  });

  it('leaves days with no activity at zero', () => {
    const cal = buildCalendar([repo()], { days: 5, now: NOW });
    assert.ok(cal.cells.every(c => c.raised === 0 && c.merges === 0 && c.prsOpened === 0));
  });
});

describe('dayRange', () => {
  it('ends on today and is inclusive', () => {
    const r = dayRange(3, NOW);
    assert.deepEqual(r, ['2026-08-13', '2026-08-14', '2026-08-15']);
  });
});

describe('HistoryStore.series', () => {
  function tempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-series-'));
    return new HistoryStore({ file: path.join(dir, 'history.json'), now: () => NOW });
  }

  it('keeps both scans from the same day, unlike daily()', () => {
    const store = tempStore();
    store.record(state({ fetchedAt: new Date(NOW - 3600_000).toISOString() }));
    store.record(state({ fetchedAt: new Date(NOW - 1800_000).toISOString() }));
    // Two scans, one calendar day: daily() collapses them, series() must not —
    // collapsing made the Trends page report "one scan recorded" while the
    // scan log beside it listed two.
    assert.equal(store.daily({}).length, 1);
    assert.equal(store.series({}).length, 2);
    assert.equal(store.meta.count, 2, 'series length must agree with the meta count');
  });

  it('returns oldest-first so a chart reads left to right', () => {
    const store = tempStore();
    store.record(state({ fetchedAt: new Date(NOW - 2 * DAY).toISOString() }));
    store.record(state({ fetchedAt: new Date(NOW).toISOString() }));
    const series = store.series({});
    assert.ok(Date.parse(series[0].at) < Date.parse(series[1].at));
  });

  it('honours the day window', () => {
    const store = tempStore();
    store.record(state({ fetchedAt: new Date(NOW - 40 * DAY).toISOString() }));
    store.record(state({ fetchedAt: new Date(NOW).toISOString() }));
    assert.equal(store.series({ days: 7 }).length, 1);
  });
});

describe('buildTimeline merge classification', () => {
  const iso = daysAgo => new Date(NOW - daysAgo * DAY).toISOString();
  const merge = (kind, daysAgo) => ({ number: 1, title: 't', url: 'u', kind, mergedAt: iso(daysAgo) });

  it('counts only bot-authored merges as dependency updates', () => {
    const repos = [repo({
      recentMerges: [merge('dependabot', 1), merge('renovate', 1), merge('human', 1), merge('bot', 1)]
    })];
    const t = buildTimeline(repos, { days: 30, now: NOW });
    assert.equal(t.totals.merges, 2, 'dependabot + renovate');
    assert.equal(t.totals.otherMerges, 2, 'human + generic bot');
  });

  it('reports backlog change from the backlog series, not raised minus merged', () => {
    const repos = [repo({
      alerts: {
        counts: {},
        list: [
          { severity: 'high', createdAt: iso(10), package: 'a', summary: 's', url: 'u' },
          { severity: 'high', createdAt: iso(2), package: 'b', summary: 's', url: 'u' }
        ]
      },
      recentMerges: Array.from({ length: 50 }, () => merge('dependabot', 3))
    })];
    const t = buildTimeline(repos, { days: 30, now: NOW });
    // 50 merges must not turn a growing backlog into a negative "improvement".
    assert.equal(t.backlogChange, 2);
    assert.equal(t.totals.merges, 50);
  });
});
