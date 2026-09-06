'use strict';

// The compact HistoryStore format remains the single persisted source. These
// projections keep the timeline/sparkline API compatible with the newer views.
function legacySnapshot(row) {
  return {
    at: row.at, repos: row.activeCount, coverage: row.coverage.percent,
    critical: row.alerts.critical, high: row.alerts.high,
    medium: row.alerts.medium, low: row.alerts.low, alerts: row.alerts.total,
    dependabotPrs: row.prs.dependabot, otherPrs: row.prs.other,
    noConfig: row.coverage.noConfig, staleScans: row.coverage.staleScans,
    byRepo: Object.fromEntries(row.repos.map(r => [r.n, r.a]))
  };
}

function canonicalSnapshot(row) {
  const repos = Object.entries(row.byRepo || {}).map(([n, a]) => ({ n, a, r: 0, c: 0, h: 0, p: 0 }));
  return {
    at: row.at, day: row.at?.slice(0, 10),
    activeCount: row.repos ?? repos.length, repoCount: row.repos ?? repos.length,
    archivedCount: 0, repos,
    alerts: { critical: row.critical || 0, high: row.high || 0, medium: row.medium || 0, low: row.low || 0, total: row.alerts || 0 },
    prs: { dependabot: row.dependabotPrs || 0, other: row.otherPrs || 0, total: (row.dependabotPrs || 0) + (row.otherPrs || 0) },
    coverage: { percent: row.coverage ?? null, noConfig: row.noConfig || 0, staleScans: row.staleScans || 0 },
    risk: { total: 0 }
  };
}

function changesSince(rows, since) {
  if (rows.length < 2) return null;
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return null;
  const latest = rows.at(-1);
  const baseline = rows.findLast(r => Date.parse(r.at) <= cutoff);
  if (!baseline || baseline === latest) return null;
  const names = new Set([...Object.keys(baseline.byRepo), ...Object.keys(latest.byRepo)]);
  const repos = [...names].flatMap(repo => {
    const before = baseline.byRepo[repo] ?? 0;
    const after = latest.byRepo[repo] ?? 0;
    return before === after ? [] : [{ repo, before, after, delta: after - before }];
  }).sort((a, b) => b.delta - a.delta);
  return {
    since: baseline.at, until: latest.at,
    critical: latest.critical - baseline.critical, high: latest.high - baseline.high,
    alerts: latest.alerts - baseline.alerts,
    dependabotPrs: latest.dependabotPrs - baseline.dependabotPrs,
    coverage: latest.coverage != null && baseline.coverage != null ? latest.coverage - baseline.coverage : null,
    repos
  };
}

module.exports = { legacySnapshot, canonicalSnapshot, changesSince };
