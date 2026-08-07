'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Append-only snapshot log, one JSON object per line.
 *
 * The patch board is otherwise entirely point-in-time: it can tell you there
 * are three criticals open, but not whether that is better or worse than last
 * week. A snapshot per refresh is enough to answer "are we getting better?"
 * without standing up a database.
 */

/** Reduce a collector state to the handful of numbers worth keeping forever. */
function snapshot(state, at) {
  const s = state.summary || {};
  const alerts = s.alerts || {};
  return {
    at,
    repos: s.activeCount ?? (state.repos || []).length,
    coverage: s.coverage?.percent ?? null,
    critical: alerts.critical || 0,
    high: alerts.high || 0,
    medium: alerts.medium || 0,
    low: alerts.low || 0,
    alerts: alerts.total || 0,
    dependabotPrs: s.prs?.dependabot || 0,
    otherPrs: s.prs?.other || 0,
    noConfig: s.coverage?.noConfig?.length || 0,
    staleScans: s.coverage?.staleScans?.length || 0,
    // Per-repo alert totals, so a row can draw its own sparkline
    byRepo: Object.fromEntries((state.repos || []).map(r => [r.fullName, r.alerts.counts.total || 0]))
  };
}

class History {
  constructor({ file, retentionDays = 180 } = {}) {
    this.file = file;
    this.retentionDays = retentionDays;
  }

  /** Every snapshot still inside the retention window, oldest first. */
  read() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (Date.parse(row.at) >= cutoff) rows.push(row);
      } catch { /* a torn final line shouldn't lose the rest of the history */ }
    }
    return rows;
  }

  append(row) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
      this.prune();
    } catch (e) {
      console.warn('[history] could not append snapshot:', e.message);
    }
  }

  /** Rewrite the file without expired rows. Cheap: this file stays small. */
  prune() {
    try {
      const { size } = fs.statSync(this.file);
      // Only bother once the file is big enough to be worth rewriting
      if (size < 256 * 1024) return;
      const kept = this.read();
      fs.writeFileSync(this.file, kept.map(r => `${JSON.stringify(r)}\n`).join(''));
    } catch { /* pruning is best-effort */ }
  }

  /**
   * Compare the newest snapshot against the newest one taken at or before
   * `since`, so the UI can say what actually changed since your last visit.
   */
  changesSince(since) {
    const rows = this.read();
    if (rows.length < 2) return null;
    const latest = rows[rows.length - 1];
    const cutoff = Date.parse(since);
    if (Number.isNaN(cutoff)) return null;

    let baseline = null;
    for (const row of rows) {
      if (Date.parse(row.at) <= cutoff) baseline = row;
      else break;
    }
    if (!baseline || baseline === latest) return null;

    const repoChanges = [];
    for (const [repo, total] of Object.entries(latest.byRepo || {})) {
      const before = baseline.byRepo?.[repo];
      if (before == null || before === total) continue;
      repoChanges.push({ repo, before, after: total, delta: total - before });
    }
    repoChanges.sort((a, b) => b.delta - a.delta);

    return {
      since: baseline.at,
      until: latest.at,
      critical: latest.critical - baseline.critical,
      high: latest.high - baseline.high,
      alerts: latest.alerts - baseline.alerts,
      dependabotPrs: latest.dependabotPrs - baseline.dependabotPrs,
      coverage: latest.coverage != null && baseline.coverage != null
        ? latest.coverage - baseline.coverage
        : null,
      repos: repoChanges
    };
  }

  /** Alert totals over time for one repo, for its sparkline. */
  seriesFor(fullName) {
    return this.read()
      .filter(r => r.byRepo && fullName in r.byRepo)
      .map(r => ({ at: r.at, value: r.byRepo[fullName] }));
  }
}

module.exports = { History, snapshot };
