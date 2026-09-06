'use strict';

/**
 * Day-one history, derived from the current scan.
 *
 * The snapshot store (lib/history.js) only knows what happened since this
 * dashboard was first started. But every open alert and every open PR already
 * carries the date it was raised, and merged update PRs carry the date they
 * landed — so the shape of the last 90 days can be reconstructed from a single
 * scan, without waiting for the snapshot series to fill in.
 *
 * The honest caveat, which the UI states: the backlog series counts alerts that
 * are *still open*. An alert raised in May and fixed in June never appears, so
 * historical points are a floor, not the true count on that day. Anything
 * derived this way is tagged `derived: true`.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** A merge only counts as a dependency update if a bot opened it. */
function isDependencyMerge(merge) {
  return merge.kind === 'dependabot' || merge.kind === 'renovate';
}

function dayKey(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings ending today, oldest first. */
function dayRange(days, now = Date.now()) {
  const out = [];
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

function emptyBuckets(days) {
  return Object.fromEntries(days.map(d => [d, 0]));
}

/**
 * Everything the Trends and Calendar views need, bucketed by day.
 * `repos` is the collector's posture list.
 */
function buildTimeline(repos = [], { days = 90, now = Date.now() } = {}) {
  const range = dayRange(days, now);
  const first = range[0];
  const index = new Map(range.map((d, i) => [d, i]));

  const raised = { total: emptyBuckets(range) };
  for (const sev of SEVERITIES) raised[sev] = emptyBuckets(range);

  const prsOpened = emptyBuckets(range);
  const merges = emptyBuckets(range);        // dependency updates only
  const otherMerges = emptyBuckets(range);   // everything else a human landed
  const scans = emptyBuckets(range);

  // Alerts that predate the window still count toward the backlog baseline;
  // dropping them would draw a series that starts at zero and looks like the
  // backlog was clean 90 days ago.
  const backlogBaseline = { total: 0 };
  for (const sev of SEVERITIES) backlogBaseline[sev] = 0;
  let prBaseline = 0;

  const perDayDetail = new Map(range.map(d => [d, { alerts: [], prs: [], merges: [] }]));
  const active = repos.filter(r => !r.archived);

  for (const repo of active) {
    for (const alert of repo.alerts?.list || []) {
      const sev = SEVERITIES.includes(alert.severity) ? alert.severity : 'low';
      const day = dayKey(alert.createdAt);
      if (day && index.has(day)) {
        raised.total[day]++;
        raised[sev][day]++;
        const detail = perDayDetail.get(day);
        if (detail.alerts.length < 40) {
          detail.alerts.push({
            repo: repo.fullName, severity: sev, package: alert.package,
            summary: alert.summary, url: alert.url, patchedVersion: alert.patchedVersion
          });
        }
      } else if (!day || day < first) {
        backlogBaseline.total++;
        backlogBaseline[sev]++;
      }
    }

    for (const pr of [...(repo.prs?.dependabot || []), ...(repo.prs?.other || [])]) {
      const day = dayKey(pr.createdAt);
      if (day && index.has(day)) {
        prsOpened[day]++;
        const detail = perDayDetail.get(day);
        if (detail.prs.length < 40) {
          detail.prs.push({ repo: repo.fullName, number: pr.number, title: pr.title, url: pr.url, kind: pr.kind });
        }
      } else if (!day || day < first) {
        prBaseline++;
      }
    }

    for (const merged of repo.recentMerges || []) {
      const day = dayKey(merged.mergedAt);
      if (!day || !index.has(day)) continue;
      if (isDependencyMerge(merged)) merges[day]++;
      else otherMerges[day]++;
      const detail = perDayDetail.get(day);
      if (detail.merges.length < 40) {
        detail.merges.push({ repo: repo.fullName, number: merged.number, title: merged.title, url: merged.url, kind: merged.kind });
      }
    }

    const scanDay = dayKey(repo.lastScan?.at);
    if (scanDay && index.has(scanDay)) scans[scanDay]++;
  }

  // Cumulative backlog: alerts still open today, by the day each was raised.
  const backlog = { total: [] };
  for (const sev of SEVERITIES) backlog[sev] = [];
  const running = { ...backlogBaseline };
  for (const day of range) {
    running.total += raised.total[day];
    for (const sev of SEVERITIES) running[sev] += raised[sev][day];
    backlog.total.push(running.total);
    for (const sev of SEVERITIES) backlog[sev].push(running[sev]);
  }

  let prRunning = prBaseline;
  const prBacklog = range.map(day => (prRunning += prsOpened[day]));

  const asSeries = buckets => range.map(d => buckets[d]);

  return {
    derived: true,
    days: range,
    generatedAt: new Date(now).toISOString(),
    baseline: { alerts: backlogBaseline, prs: prBaseline },
    backlog,
    prBacklog,
    raised: { total: asSeries(raised.total), ...Object.fromEntries(SEVERITIES.map(s => [s, asSeries(raised[s])])) },
    prsOpened: asSeries(prsOpened),
    merges: asSeries(merges),
    otherMerges: asSeries(otherMerges),
    scans: asSeries(scans),
    totals: {
      raised: range.reduce((sum, d) => sum + raised.total[d], 0),
      merges: range.reduce((sum, d) => sum + merges[d], 0),
      otherMerges: range.reduce((sum, d) => sum + otherMerges[d], 0),
      prsOpened: range.reduce((sum, d) => sum + prsOpened[d], 0)
    },
    // The real backlog movement over the window, read off the backlog series
    // itself. Subtracting merged PRs from raised alerts mixes two different
    // units and produced a reassuring negative number while the backlog grew.
    backlogChange: backlog.total[backlog.total.length - 1] - backlog.total[0]
  };
}

/**
 * Calendar cells: one entry per day with the counts that colour the heatmap and
 * the detail shown when a day is clicked.
 */
function buildCalendar(repos = [], { days = 90, now = Date.now() } = {}) {
  const range = dayRange(days, now);
  const index = new Set(range);
  const cells = new Map(range.map(d => [d, {
    date: d,
    raised: 0, critical: 0, high: 0, medium: 0, low: 0,
    merges: 0, otherMerges: 0, prsOpened: 0, scans: 0,
    alerts: [], prs: [], mergeList: []
  }]));

  for (const repo of repos.filter(r => !r.archived)) {
    for (const alert of repo.alerts?.list || []) {
      const day = dayKey(alert.createdAt);
      if (!day || !index.has(day)) continue;
      const cell = cells.get(day);
      const sev = SEVERITIES.includes(alert.severity) ? alert.severity : 'low';
      cell.raised++;
      cell[sev]++;
      if (cell.alerts.length < 25) {
        cell.alerts.push({
          repo: repo.fullName, severity: sev, package: alert.package,
          summary: alert.summary, url: alert.url, patchedVersion: alert.patchedVersion
        });
      }
    }
    for (const pr of [...(repo.prs?.dependabot || []), ...(repo.prs?.other || [])]) {
      const day = dayKey(pr.createdAt);
      if (!day || !index.has(day)) continue;
      const cell = cells.get(day);
      cell.prsOpened++;
      if (cell.prs.length < 25) cell.prs.push({ repo: repo.fullName, number: pr.number, title: pr.title, url: pr.url, kind: pr.kind });
    }
    for (const merged of repo.recentMerges || []) {
      const day = dayKey(merged.mergedAt);
      if (!day || !index.has(day)) continue;
      const cell = cells.get(day);
      if (isDependencyMerge(merged)) cell.merges++;
      else cell.otherMerges++;
      if (cell.mergeList.length < 25) cell.mergeList.push({ repo: repo.fullName, number: merged.number, title: merged.title, url: merged.url, kind: merged.kind });
    }
    const scanDay = dayKey(repo.lastScan?.at);
    if (scanDay && index.has(scanDay)) cells.get(scanDay).scans++;
  }

  return { derived: true, days: range, cells: [...cells.values()] };
}

module.exports = { buildTimeline, buildCalendar, dayRange, dayKey, isDependencyMerge, SEVERITIES };
