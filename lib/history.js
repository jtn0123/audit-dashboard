'use strict';

/**
 * A local time series of scan snapshots.
 *
 * GitHub answers "what is true now" and nothing else — there is no API for
 * "how many alerts were open last Tuesday". So every completed scan appends a
 * compact snapshot here, and Trends / History / Calendar read it back.
 *
 * Writes stay on the same cache volume as the repo cache: local only, no
 * credentials, no GitHub writes.
 */

const fs = require('fs');
const path = require('path');

const MAX_SNAPSHOTS = 400;
const FINE_GRAIN_HOURS = 48;      // below this age, every snapshot is kept
const DEFAULT_RETENTION_DAYS = 180;
const MAX_REPOS_PER_SNAPSHOT = 150;

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

function dayOf(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : null;
}

function countFlag(repos, pick) {
  const out = { enabled: 0, disabled: 0, unknown: 0 };
  for (const r of repos) {
    const v = pick(r);
    if (v === true) out.enabled++;
    else if (v === false) out.disabled++;
    else out.unknown++;
  }
  return out;
}

/**
 * Reduce a collector state into the smallest record that can still answer the
 * trend questions. Per-repo entries use short keys because this file is
 * rewritten on every scan and read on every chart render.
 */
function snapshotFrom(state, { now = Date.now() } = {}) {
  const summary = state.summary || {};
  const repos = Array.isArray(state.repos) ? state.repos : [];
  const active = repos.filter(r => !r.archived);
  const alerts = summary.alerts || { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  const coverage = summary.coverage || {};
  const prs = summary.prs || {};

  const risks = active.map(r => r.risk || 0);
  const at = state.fetchedAt || new Date(now).toISOString();

  return {
    at,
    day: dayOf(at),
    durationMs: state.durationMs ?? null,
    repoCount: summary.repoCount ?? repos.length,
    activeCount: summary.activeCount ?? active.length,
    archivedCount: summary.archivedCount ?? (repos.length - active.length),
    alerts: {
      critical: alerts.critical || 0,
      high: alerts.high || 0,
      medium: alerts.medium || 0,
      low: alerts.low || 0,
      total: alerts.total || 0
    },
    coverage: {
      covered: coverage.covered ?? null,
      percent: coverage.percent ?? null,
      noConfig: (coverage.noConfig || []).length,
      alertsOff: (coverage.alertsOff || []).length,
      securityUpdatesOff: (coverage.securityUpdatesOff || []).length,
      staleScans: (coverage.staleScans || []).length,
      neverScanned: (coverage.neverScanned || []).length
    },
    prs: {
      dependabot: prs.dependabot || 0,
      other: prs.other || 0,
      stale: prs.stale || 0,
      total: prs.total || 0
    },
    codeScanning: countFlag(active, r => r.codeScanning?.enabled),
    secretScanning: countFlag(active, r => r.secretScanning?.enabled),
    reposNeedingAttention: summary.reposNeedingAttention ?? active.filter(r => r.risk > 0).length,
    risk: {
      total: risks.reduce((a, b) => a + b, 0),
      max: risks.length ? Math.max(...risks) : 0,
      mean: risks.length ? Math.round(risks.reduce((a, b) => a + b, 0) / risks.length) : 0
    },
    errorCount: (state.errors || []).length,
    repos: active.slice(0, MAX_REPOS_PER_SNAPSHOT).map(r => ({
      n: r.fullName,
      r: r.risk || 0,
      a: r.alerts?.counts?.total || 0,
      c: r.alerts?.counts?.critical || 0,
      h: r.alerts?.counts?.high || 0,
      p: r.prs?.counts?.total || 0
    }))
  };
}

/**
 * Thin out old snapshots: everything inside the fine-grain window survives,
 * older days keep only their last snapshot, and anything past the retention
 * horizon is dropped. Keeps the file bounded without losing the shape of the
 * long-run trend.
 */
function compact(snapshots, { now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const sorted = [...snapshots]
    .filter(s => s && s.at && !Number.isNaN(Date.parse(s.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const horizon = now - retentionDays * 86_400_000;
  const fineGrainCutoff = now - FINE_GRAIN_HOURS * 3_600_000;

  const lastPerDay = new Map();
  for (const s of sorted) {
    if (Date.parse(s.at) < horizon) continue;
    lastPerDay.set(s.day || dayOf(s.at), s);
  }

  const kept = sorted.filter(s => {
    const t = Date.parse(s.at);
    if (t < horizon) return false;
    if (t >= fineGrainCutoff) return true;
    return lastPerDay.get(s.day || dayOf(s.at)) === s;
  });

  return kept.length > MAX_SNAPSHOTS ? kept.slice(kept.length - MAX_SNAPSHOTS) : kept;
}

/** Difference two snapshots into the deltas the History view shows per scan. */
function diffSnapshots(current, previous) {
  if (!previous) return null;
  const d = (a, b) => (a ?? 0) - (b ?? 0);
  const movers = [];
  const prevByRepo = new Map((previous.repos || []).map(r => [r.n, r]));
  for (const repo of current.repos || []) {
    const before = prevByRepo.get(repo.n);
    if (!before) { movers.push({ repo: repo.n, kind: 'added', alerts: repo.a, delta: repo.a }); continue; }
    const delta = repo.a - before.a;
    if (delta !== 0) movers.push({ repo: repo.n, kind: delta > 0 ? 'worse' : 'better', alerts: repo.a, delta });
  }
  const currentRepos = new Set((current.repos || []).map(r => r.n));
  for (const repo of previous.repos || []) {
    if (!currentRepos.has(repo.n)) movers.push({ repo: repo.n, kind: 'removed', alerts: 0, delta: -repo.a });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    alerts: Object.fromEntries([...SEVERITIES, 'total'].map(s => [s, d(current.alerts[s], previous.alerts[s])])),
    prs: { total: d(current.prs.total, previous.prs.total), dependabot: d(current.prs.dependabot, previous.prs.dependabot) },
    coveragePercent: current.coverage.percent != null && previous.coverage.percent != null
      ? current.coverage.percent - previous.coverage.percent : null,
    repoCount: d(current.repoCount, previous.repoCount),
    riskTotal: d(current.risk?.total, previous.risk?.total),
    movers: movers.slice(0, 8)
  };
}

class HistoryStore {
  constructor({ file, retentionDays = DEFAULT_RETENTION_DAYS, now = () => Date.now() } = {}) {
    this.file = file;
    this.retentionDays = retentionDays;
    this.now = now;
    this.snapshots = [];
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw?.snapshots)) this.snapshots = compact(raw.snapshots, { now: this.now(), retentionDays: this.retentionDays });
    } catch { /* no history yet — the first scan starts it */ }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, snapshots: this.snapshots }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[history] could not persist scan history:', e.message);
    }
  }

  /**
   * Append one scan. Snapshots are keyed by `fetchedAt`, so a cache reload that
   * replays the same scan does not double-count it.
   */
  record(state) {
    const snapshot = snapshotFrom(state, { now: this.now() });
    if (this.snapshots.some(s => s.at === snapshot.at)) return snapshot;
    this.snapshots.push(snapshot);
    this.snapshots = compact(this.snapshots, { now: this.now(), retentionDays: this.retentionDays });
    this.save();
    return snapshot;
  }

  /** Snapshots newest-first, optionally limited to the last `days`. */
  list({ days } = {}) {
    let out = [...this.snapshots].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (days > 0) {
      const cutoff = this.now() - days * 86_400_000;
      out = out.filter(s => Date.parse(s.at) >= cutoff);
    }
    return out;
  }

  /** One representative snapshot per day (the last of that day), oldest-first. */
  daily({ days } = {}) {
    const byDay = new Map();
    for (const s of this.list({ days }).reverse()) byDay.set(s.day, s);
    return [...byDay.values()];
  }

  /**
   * Every retained snapshot, oldest-first — what the trend chart plots.
   *
   * Not `daily()`: compaction already thins anything past the fine-grain
   * window down to one per day, so this is dense only where it is useful.
   * Charting the daily view instead made two scans on the same day render as
   * one point, so the page reported "one scan recorded" while the scan log
   * beside it listed two.
   */
  series({ days } = {}) {
    return this.list({ days }).reverse();
  }

  /** What the History view renders: each scan with its delta from the one before. */
  timelineWithDeltas({ days, limit = 100 } = {}) {
    const newestFirst = this.list({ days });
    return newestFirst.slice(0, limit).map((snapshot, i) => ({
      ...snapshot,
      delta: diffSnapshots(snapshot, newestFirst[i + 1] || null)
    }));
  }

  get meta() {
    const oldest = this.snapshots[0];
    const newest = this.snapshots[this.snapshots.length - 1];
    return {
      count: this.snapshots.length,
      since: oldest?.at || null,
      latest: newest?.at || null,
      days: oldest && newest
        ? Math.max(1, Math.round((Date.parse(newest.at) - Date.parse(oldest.at)) / 86_400_000) + 1)
        : 0,
      retentionDays: this.retentionDays
    };
  }
}

module.exports = { HistoryStore, snapshotFrom, compact, diffSnapshots, MAX_SNAPSHOTS, DEFAULT_RETENTION_DAYS };
