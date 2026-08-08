'use strict';

/**
 * Pure functions that turn raw GitHub responses into the "where do I need to
 * patch?" view model. No network, no fs — everything here is unit-testable.
 */

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const DEPENDABOT_LOGINS = ['dependabot[bot]', 'dependabot-preview[bot]'];
const RENOVATE_LOGINS = ['renovate[bot]', 'renovate-bot'];

function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

function newest(...isoDates) {
  const valid = isoDates.filter(Boolean).map(d => [d, Date.parse(d)]).filter(([, t]) => !Number.isNaN(t));
  if (!valid.length) return null;
  return valid.sort((a, b) => b[1] - a[1])[0][0];
}

/** Classify who opened a PR so bot noise can be separated from human review work. */
function classifyPr(pr) {
  const login = (pr.user?.login || '').toLowerCase();
  const head = (pr.head?.ref || '').toLowerCase();
  if (DEPENDABOT_LOGINS.includes(login) || head.startsWith('dependabot/')) return 'dependabot';
  if (RENOVATE_LOGINS.includes(login) || head.startsWith('renovate/')) return 'renovate';
  if (pr.user?.type === 'Bot' || login.endsWith('[bot]')) return 'bot';
  return 'human';
}

/** Pull the package + version out of a Dependabot PR title, when it follows the usual shape. */
function parseBumpTitle(title = '') {
  const m = title.match(/bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i);
  return m ? { package: m[1], from: m[2], to: m[3] } : null;
}

function normalizePr(pr, now = Date.now()) {
  const kind = classifyPr(pr);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login || 'unknown',
    kind,
    draft: Boolean(pr.draft),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    ageDays: daysSince(pr.created_at, now),
    labels: (pr.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
    baseRef: pr.base?.ref || null,
    headRef: pr.head?.ref || null,
    headSha: pr.head?.sha || null,
    bump: kind === 'dependabot' || kind === 'renovate' ? parseBumpTitle(pr.title) : null,
    // Filled in later by the collector when check/file data is fetched
    checks: null,
    mergeable: null,
    files: null
  };
}

function normalizeAlert(alert, now = Date.now()) {
  const adv = alert.security_advisory || {};
  const vuln = alert.security_vulnerability || {};
  return {
    number: alert.number,
    url: alert.html_url,
    severity: (vuln.severity || adv.severity || 'low').toLowerCase(),
    summary: adv.summary || 'Unknown advisory',
    ghsaId: adv.ghsa_id || null,
    cveId: adv.cve_id || null,
    package: vuln.package?.name || alert.dependency?.package?.name || 'unknown',
    ecosystem: vuln.package?.ecosystem || alert.dependency?.package?.ecosystem || null,
    manifest: alert.dependency?.manifest_path || null,
    vulnerableRange: vuln.vulnerable_version_range || null,
    patchedVersion: vuln.first_patched_version?.identifier || null,
    scope: alert.dependency?.scope || null,
    createdAt: alert.created_at,
    updatedAt: alert.updated_at,
    ageDays: daysSince(alert.created_at, now),
    autoDismissed: Boolean(alert.auto_dismissed_at)
  };
}

function countBySeverity(alerts) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const a of alerts) {
    const sev = SEVERITIES.includes(a.severity) ? a.severity : 'low';
    counts[sev]++;
    counts.total++;
  }
  return counts;
}

/**
 * Decide when this repo's dependencies were last actually looked at.
 * Dependabot has no "last scan" API, so we take the freshest piece of evidence
 * and report which signal it came from — a guess labelled as a guess.
 */
function resolveLastScan(signals = {}, now = Date.now()) {
  const candidates = [
    { at: signals.dependabotRunAt, source: 'dependabot-run', label: 'Dependabot update job' },
    { at: signals.alertUpdatedAt, source: 'alert-activity', label: 'Alert activity' },
    { at: signals.dependabotPrAt, source: 'dependabot-pr', label: 'Dependabot PR' }
  ].filter(c => c.at && !Number.isNaN(Date.parse(c.at)));

  if (!candidates.length) return { at: null, source: 'none', label: 'No evidence of a scan', ageDays: null };
  candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const best = candidates[0];
  return { ...best, ageDays: daysSince(best.at, now) };
}

const GAP_DEFS = {
  'alerts-disabled': { label: 'Dependabot alerts off', severity: 'critical', weight: 35, hint: 'Settings → Code security → enable Dependabot alerts' },
  'no-dependabot-config': { label: 'No dependabot.yml', severity: 'high', weight: 18, hint: 'Add .github/dependabot.yml to get version-update PRs' },
  'security-updates-disabled': { label: 'Security updates off', severity: 'high', weight: 10, hint: 'Enable Dependabot security updates for automatic fix PRs' },
  'never-scanned': { label: 'Never scanned', severity: 'high', weight: 12, hint: 'No Dependabot run, alert, or PR has ever been seen' },
  'stale-scan': { label: 'Scan is stale', severity: 'medium', weight: 10, hint: 'No dependency scan evidence recently' },
  'stale-prs': { label: 'Stale update PRs', severity: 'medium', weight: 0, hint: 'Dependabot PRs have been sitting open' },
  'unpatched-critical': { label: 'Unpatched critical alerts', severity: 'critical', weight: 0, hint: 'Patch or dismiss the critical advisories' },
  'unpatched-high': { label: 'Unpatched high alerts', severity: 'high', weight: 0, hint: 'Patch or dismiss the high advisories' }
};

/**
 * Build the full posture record for one repo.
 * `raw` carries whatever the collector managed to fetch; missing pieces degrade
 * to `null` (unknown) rather than being reported as "fine".
 */
function buildRepoPosture(raw, { staleDays = 14, stalePrDays = 14, now = Date.now() } = {}) {
  const repo = raw.repo || {};
  const alerts = (raw.alerts || []).map(a => normalizeAlert(a, now));
  const prs = (raw.pulls || []).map(p => normalizePr(p, now));

  const alertCounts = countBySeverity(alerts);
  const dependabotPrs = prs.filter(p => p.kind === 'dependabot' || p.kind === 'renovate');
  const otherPrs = prs.filter(p => p.kind === 'human' || p.kind === 'bot');
  const stalePrs = dependabotPrs.filter(p => (p.ageDays ?? 0) >= stalePrDays);

  const lastScan = resolveLastScan({
    dependabotRunAt: raw.dependabotRunAt,
    alertUpdatedAt: newest(...alerts.map(a => a.updatedAt), raw.alertUpdatedAt),
    dependabotPrAt: newest(...dependabotPrs.map(p => p.createdAt), raw.lastDependabotPrAt)
  }, now);

  const config = raw.config || { present: false, path: null, ecosystems: [], error: null };
  const alertsEnabled = raw.alertsEnabled;             // true | false | null (unknown)
  const securityUpdates = raw.securityUpdatesEnabled;  // true | false | null (unknown)

  const gaps = [];
  const addGap = (id, detail) => gaps.push({ id, ...GAP_DEFS[id], detail: detail || null });

  if (alertsEnabled === false) addGap('alerts-disabled');
  if (!config.present && !repo.archived) addGap('no-dependabot-config');
  if (securityUpdates === false) addGap('security-updates-disabled');
  if (alertCounts.critical > 0) addGap('unpatched-critical', `${alertCounts.critical} open`);
  if (alertCounts.high > 0) addGap('unpatched-high', `${alertCounts.high} open`);
  if (lastScan.source === 'none' && alertsEnabled !== false) addGap('never-scanned');
  else if (lastScan.ageDays != null && lastScan.ageDays > staleDays) addGap('stale-scan', `${lastScan.ageDays}d ago`);
  if (stalePrs.length) addGap('stale-prs', `${stalePrs.length} open >${stalePrDays}d`);

  // A single unpatched critical outranks a repo that merely lacks a config —
  // one is exploitable today, the other is a process gap.
  let risk =
    alertCounts.critical * 40 +
    alertCounts.high * 18 +
    alertCounts.medium * 5 +
    alertCounts.low * 1 +
    gaps.reduce((sum, g) => sum + (g.weight || 0), 0) +
    Math.min(10, stalePrs.length * 3);
  if (repo.archived) risk = Math.round(risk / 4);
  risk = Math.min(100, risk);

  return {
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner?.login || (repo.full_name || '').split('/')[0],
    url: repo.html_url,
    description: repo.description || null,
    private: Boolean(repo.private),
    archived: Boolean(repo.archived),
    fork: Boolean(repo.fork),
    language: repo.language || null,
    defaultBranch: repo.default_branch || null,
    pushedAt: repo.pushed_at || null,
    pushedDaysAgo: daysSince(repo.pushed_at, now),

    dependabot: {
      configPresent: config.present,
      configPath: config.path,
      ecosystems: config.ecosystems || [],
      schedules: config.schedules || [],
      configError: config.error || null,
      alertsEnabled,
      securityUpdatesEnabled: securityUpdates,
      alertsError: raw.alertsError || null
    },

    alerts: {
      counts: alertCounts,
      // null means unknown here, so an alert opened today must stay 0, not null.
      oldestOpenDays: alerts.length ? alerts.reduce((max, a) => Math.max(max, a.ageDays ?? 0), 0) : null,
      list: alerts
    },
    prs: {
      dependabot: dependabotPrs,
      other: otherPrs,
      counts: {
        dependabot: dependabotPrs.length,
        other: otherPrs.length,
        stale: stalePrs.length,
        drafts: prs.filter(p => p.draft).length,
        total: prs.length
      }
    },

    codeScanning: raw.codeScanning || { enabled: null, lastAnalysisAt: null },
    secretScanning: raw.secretScanning || { enabled: null },

    lastScan,
    gaps,
    risk,
    action: recommendedAction({ alertCounts, gaps, dependabotPrs, lastScan, alertsEnabled }),
    errors: raw.errors || []
  };
}

/** The single next thing to do for this repo — drives the "Action" column. */
function recommendedAction({ alertCounts, gaps, dependabotPrs, lastScan, alertsEnabled }) {
  const has = id => gaps.some(g => g.id === id);
  if (alertsEnabled === false) return { text: 'Turn on Dependabot alerts', tone: 'critical' };
  if (alertCounts.critical) return { text: `Patch ${alertCounts.critical} critical alert${alertCounts.critical > 1 ? 's' : ''}`, tone: 'critical' };
  if (alertCounts.high) return { text: `Patch ${alertCounts.high} high alert${alertCounts.high > 1 ? 's' : ''}`, tone: 'critical' };
  if (dependabotPrs.length) return { text: `Merge ${dependabotPrs.length} update PR${dependabotPrs.length > 1 ? 's' : ''}`, tone: 'warning' };
  // Driven off the gap so archived repos, which never get this gap, are never
  // told to edit a read-only repository.
  if (has('no-dependabot-config')) return { text: 'Add dependabot.yml', tone: 'warning' };
  if (has('security-updates-disabled')) return { text: 'Enable security updates', tone: 'warning' };
  if (has('never-scanned')) return { text: 'Never scanned — check setup', tone: 'warning' };
  if (has('stale-scan')) return { text: `No scan in ${lastScan.ageDays}d`, tone: 'warning' };
  if (alertCounts.total) return { text: `${alertCounts.total} low/medium alerts`, tone: 'warning' };
  return { text: 'Up to date', tone: 'ok' };
}

/** Cross-repo rollup for the KPI row at the top of the dashboard. */
function summarize(repos, { staleDays = 14 } = {}) {
  const active = repos.filter(r => !r.archived);
  const alertTotals = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  let dependabotPrs = 0, otherPrs = 0, stalePrs = 0;

  // Every KPI counts active repos only: archived ones can't be patched, and the
  // coverage view already excludes them — mixing bases makes the numbers disagree.
  for (const r of active) {
    for (const sev of [...SEVERITIES, 'total']) alertTotals[sev] += r.alerts.counts[sev] || 0;
    dependabotPrs += r.prs.counts.dependabot;
    otherPrs += r.prs.counts.other;
    stalePrs += r.prs.counts.stale;
  }

  const noConfig = active.filter(r => !r.dependabot.configPresent);
  const alertsOff = active.filter(r => r.dependabot.alertsEnabled === false);
  const securityUpdatesOff = active.filter(r => r.dependabot.securityUpdatesEnabled === false);
  const staleScans = active.filter(r => r.lastScan.ageDays != null && r.lastScan.ageDays > staleDays);
  const neverScanned = active.filter(r => r.lastScan.source === 'none');
  const covered = active.filter(r => r.dependabot.configPresent && r.dependabot.alertsEnabled !== false);

  return {
    repoCount: repos.length,
    activeCount: active.length,
    archivedCount: repos.length - active.length,
    coverage: {
      covered: covered.length,
      percent: active.length ? Math.round((covered.length / active.length) * 100) : null,
      noConfig: noConfig.map(r => r.fullName),
      alertsOff: alertsOff.map(r => r.fullName),
      securityUpdatesOff: securityUpdatesOff.map(r => r.fullName),
      staleScans: staleScans.map(r => r.fullName),
      neverScanned: neverScanned.map(r => r.fullName)
    },
    alerts: alertTotals,
    prs: { dependabot: dependabotPrs, other: otherPrs, stale: stalePrs, total: dependabotPrs + otherPrs },
    reposNeedingAttention: active.filter(r => r.risk > 0).length,
    topRisk: [...repos].sort((a, b) => b.risk - a.risk).slice(0, 5)
      .map(r => ({ fullName: r.fullName, risk: r.risk, action: r.action.text }))
  };
}

module.exports = {
  SEVERITIES,
  GAP_DEFS,
  daysSince,
  newest,
  classifyPr,
  parseBumpTitle,
  normalizePr,
  normalizeAlert,
  countBySeverity,
  resolveLastScan,
  buildRepoPosture,
  recommendedAction,
  summarize
};
