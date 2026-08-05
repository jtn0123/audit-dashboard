/* Patch command center — cross-repo Dependabot coverage, alerts and open PRs.
   Depends on helpers defined in app.js ($, app, api, navigate, severityBadge). */

let ghState = { repos: [], overview: null, status: null, history: null, changes: null };
let repoFilterKey = 'attention';
let repoSort = 'risk';
let repoSearch = '';
const expandedRepos = new Set();
const selectedPrs = new Set();

// === URL-backed view state ===============================================
// Filters live in the hash rather than sessionStorage so a view is
// bookmarkable, shareable and survives a reload with its state intact.

function routePath() {
  const hash = window.location.hash.slice(1) || '/';
  const q = hash.indexOf('?');
  return q === -1 ? hash : hash.slice(0, q);
}

function routeParams() {
  const hash = window.location.hash.slice(1);
  const q = hash.indexOf('?');
  return new URLSearchParams(q === -1 ? '' : hash.slice(q + 1));
}

/** Merge params into the hash. null/'' removes a key. Replaces history entry. */
function setParams(updates, { replace = true } = {}) {
  const params = routeParams();
  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  const next = `#${routePath()}${qs ? `?${qs}` : ''}`;
  if (replace) window.history.replaceState(null, '', next);
  else window.location.hash = next.slice(1);
}

/** Pull filter/sort/search out of the URL before a render. */
function syncStateFromUrl() {
  const params = routeParams();
  repoFilterKey = params.get('filter') || 'attention';
  repoSort = params.get('sort') || 'risk';
  repoSearch = params.get('q') || '';
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

const FILTERS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'critical', label: 'Critical / high' },
  { key: 'sla', label: 'Past budget' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'dependabot-prs', label: 'Update PRs' },
  { key: 'ci-failing', label: 'CI red' },
  { key: 'no-dependabot', label: 'No Dependabot' },
  { key: 'stale', label: 'Stale scans' },
  { key: 'clean', label: 'Clean' },
  { key: 'all', label: 'All repos' }
];

/** Human summary of the configured age budgets, for the KPI subtitle. */
function slaSubtitle() {
  const sla = ghState.status?.sla;
  if (!sla) return 'age budget exceeded';
  return `C>${sla.critical}d · H>${sla.high}d`;
}

const SORTS = [
  { key: 'risk', label: 'Risk' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'prs', label: 'PRs' },
  { key: 'scan', label: 'Oldest scan' },
  { key: 'name', label: 'Name' }
];

// Language → the Dependabot ecosystem to suggest when a repo has no config.
const ECOSYSTEM_BY_LANGUAGE = {
  javascript: 'npm', typescript: 'npm', vue: 'npm', svelte: 'npm',
  python: 'pip', go: 'gomod', ruby: 'bundler', rust: 'cargo',
  java: 'maven', kotlin: 'gradle', 'c#': 'nuget', php: 'composer',
  swift: 'swift', dart: 'pub', elixir: 'hex', shell: null, dockerfile: 'docker'
};

function relTime(iso) {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(secs)) return 'unknown';
  if (secs < 60) return 'just now';
  const units = [['m', 60], ['h', 3600], ['d', 86400], ['mo', 2592000], ['y', 31536000]];
  let out = `${Math.floor(secs / 60)}m ago`;
  for (const [suffix, size] of units) {
    if (secs >= size) out = `${Math.floor(secs / size)}${suffix} ago`;
  }
  return out;
}

function ageTone(days, staleDays) {
  if (days == null) return 'red';
  if (days > staleDays) return 'yellow';
  return 'green';
}

// === Data ================================================================

/** Timestamp of the previous visit, read once per page load before we stamp it. */
const LAST_VISIT_KEY = 'ghLastVisit';
const previousVisit = localStorage.getItem(LAST_VISIT_KEY);

async function loadGitHub(force = false) {
  const status = await api('/api/gh/status');
  ghState.status = status;
  if (!status.configured) return ghState;
  if (force || !ghState.repos.length) {
    const [overview, repos] = await Promise.all([
      api('/api/gh/overview'),
      api('/api/gh/repos?filter=all&sort=risk')
    ]);
    ghState.overview = overview;
    ghState.repos = repos;

    // Best-effort extras: the board is still useful without either of them.
    if (previousVisit) {
      try { ghState.changes = await api(`/api/gh/changes?since=${encodeURIComponent(previousVisit)}`); } catch { ghState.changes = null; }
    }
    try { ghState.history = await api('/api/gh/history'); } catch { ghState.history = null; }
    localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
  }
  return ghState;
}

/** Alert totals over time for one repo, from the snapshot history. */
function seriesFor(fullName) {
  if (!Array.isArray(ghState.history)) return [];
  return ghState.history
    .filter(row => row.byRepo && fullName in row.byRepo)
    .map(row => row.byRepo[fullName]);
}

/**
 * Inline sparkline. Deliberately unlabelled — it answers "trending up or down?"
 * at a glance; the exact numbers are one click away in the row detail.
 */
function sparkline(values, { width = 68, height = 18 } = {}) {
  if (!values || values.length < 2) return '';
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 2) - 1).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  const first = values[0];
  const tone = last > first ? 'var(--red)' : last < first ? 'var(--green)' : 'var(--text-muted)';
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

/** The "what moved since you last looked" banner. */
function renderChangesBanner() {
  const c = ghState.changes;
  if (!c || !c.since) return '';
  const bits = [];
  const signed = (n, noun) => `${n > 0 ? '+' : ''}${n} ${noun}`;
  if (c.critical) bits.push(`<span class="${c.critical > 0 ? 'tone-critical' : 'tone-ok'}">${signed(c.critical, 'critical')}</span>`);
  if (c.high) bits.push(`<span class="${c.high > 0 ? 'tone-warning' : 'tone-ok'}">${signed(c.high, 'high')}</span>`);
  if (c.alerts && !c.critical && !c.high) bits.push(`<span>${signed(c.alerts, 'alerts')}</span>`);
  if (c.dependabotPrs) bits.push(`<span>${signed(c.dependabotPrs, 'update PRs')}</span>`);
  if (c.coverage) bits.push(`<span class="${c.coverage > 0 ? 'tone-ok' : 'tone-warning'}">${signed(c.coverage, '% coverage')}</span>`);
  if (!bits.length) return '';

  const movers = (c.repos || []).slice(0, 3)
    .map(r => `${esc(r.repo.split('/')[1])} ${r.delta > 0 ? '+' : ''}${r.delta}`).join(' · ');
  return `<div class="changes-banner">
    <span class="changes-label">Since your last visit (${relTime(c.since)})</span>
    ${bits.join('<span class="bullet">·</span>')}
    ${movers ? `<span class="changes-movers">${esc(movers)}</span>` : ''}
    <button class="changes-dismiss" onclick="dismissChanges()" aria-label="Dismiss">×</button>
  </div>`;
}

function dismissChanges() {
  ghState.changes = null;
  document.querySelector('.changes-banner')?.remove();
}

async function refreshGitHub(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }
  try {
    // fetch() resolves for 5xx, so check explicitly before dropping cached state.
    const response = await fetch('/api/gh/refresh', { method: 'POST' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Refresh failed (${response.status})`);
    }
    ghState.repos = [];
    await renderPatch();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh failed'; }
    console.warn('refresh failed', e);
  }
}

// === Main view ===========================================================

async function renderPatch() {
  syncStateFromUrl();
  app.innerHTML = '<div class="loading"><div class="spinner"></div>Loading repositories…</div>';
  let state;
  try { state = await loadGitHub(); } catch (e) { showError('Could not load GitHub data', e.message); return; }

  if (!state.status.configured) { app.innerHTML = renderSetupScreen(); return; }
  if (!state.repos.length) {
    app.innerHTML = `<div class="empty"><div class="icon">🔍</div><h3>No repositories collected yet</h3>
      <p>The first scan can take a minute. ${state.status.errors?.length ? esc(state.status.errors[0].message) : ''}</p>
      <button class="refresh-btn" onclick="refreshGitHub(this)" style="margin-top:16px">↻ Scan now</button></div>`;
    return;
  }

  const { summary } = state.overview;
  const staleDays = state.status.staleDays;

  app.innerHTML = `
    ${renderPatchHeader(state.status)}
    ${renderChangesBanner()}
    ${renderKpis(summary, staleDays)}
    ${renderControls()}
    <div id="repo-table"></div>`;

  renderRepoTable();
}

function renderPatchHeader(status) {
  const rate = status.rate?.remaining != null
    ? `<span title="GitHub API calls left this hour">· ${status.rate.remaining}/${status.rate.limit} API</span>` : '';
  return `<div class="patch-header">
    <div>
      <h2 class="patch-title">Patch board</h2>
      <div class="patch-sub">
        ${status.repoCount} repos${status.viewer ? ` · ${esc(status.viewer.login)}` : ''}
        · scanned ${relTime(status.fetchedAt)} ${rate}
      </div>
    </div>
    <button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>
  </div>`;
}

function renderKpis(s, staleDays) {
  const a = s.alerts;
  const cov = s.coverage;
  const tiles = [
    {
      filter: 'all', label: 'Repos tracked', value: s.activeCount,
      sub: s.archivedCount ? `${s.archivedCount} archived hidden` : 'all active'
    },
    {
      filter: 'no-dependabot', label: 'Dependabot coverage',
      value: cov.percent == null ? '—' : `${cov.percent}%`,
      tone: cov.percent >= 90 ? 'ok' : cov.percent >= 60 ? 'warning' : 'critical',
      sub: `${cov.noConfig.length} without config · ${cov.alertsOff.length} alerts off`
    },
    {
      filter: 'vulnerable', label: 'Open alerts', value: a.total,
      tone: a.critical ? 'critical' : a.high ? 'warning' : a.total ? 'warning' : 'ok',
      sub: `${a.critical}C · ${a.high}H · ${a.medium}M · ${a.low}L`,
      bar: renderSeverityBar(a)
    },
    {
      filter: 'dependabot-prs', label: 'Update PRs', value: s.prs.dependabot,
      tone: s.prs.stale ? 'warning' : 'ok',
      sub: s.prs.stale ? `${s.prs.stale} open >14d` : 'none stale'
    },
    {
      filter: 'open-prs', label: 'Other open PRs', value: s.prs.other,
      sub: 'human + app PRs', href: '#/prs'
    },
    {
      filter: 'stale', label: 'Stale scans', value: cov.staleScans.length + cov.neverScanned.length,
      tone: (cov.staleScans.length + cov.neverScanned.length) ? 'warning' : 'ok',
      sub: `${cov.neverScanned.length} never scanned · >${staleDays}d`
    },
    {
      filter: 'sla', label: 'Past budget', value: s.slaBreaches || 0,
      tone: s.slaBreaches ? 'critical' : 'ok',
      sub: slaSubtitle()
    },
    {
      filter: 'secrets', label: 'Leaked secrets', value: s.secretAlerts || 0,
      tone: s.secretAlerts ? 'critical' : 'ok',
      sub: s.secretAlerts ? 'rotate these first' : 'none open'
    }
  ];

  return `<div class="kpi-row">${tiles.map(t => `
    <div class="kpi ${t.tone ? `kpi-${t.tone}` : ''}" onclick="${t.href ? `navigate('${t.href.slice(1)}')` : `setRepoFilterKey('${t.filter}')`}">
      <div class="kpi-label">${t.label}</div>
      <div class="kpi-value">${t.value}</div>
      <div class="kpi-sub">${t.sub}</div>
      ${t.bar || ''}
    </div>`).join('')}</div>`;
}

function renderControls() {
  return `<div class="patch-controls">
    <div class="repo-filter">
      ${FILTERS.map(f => `<button class="repo-btn ${repoFilterKey === f.key ? 'active' : ''}"
        onclick="setRepoFilterKey('${f.key}')">${f.label} <span class="filter-count">${countFor(f.key)}</span></button>`).join('')}
    </div>
    <div class="patch-controls-row">
      <input class="search-input" id="repo-search" placeholder="Filter repos…  (press / )" value="${esc(repoSearch)}"
        oninput="setRepoSearch(this.value)">
      <div class="sort-bar">
        <span class="sort-label">Sort</span>
        ${SORTS.map(s => `<button class="sort-btn ${repoSort === s.key ? 'active' : ''}"
          onclick="setRepoSort('${s.key}')">${s.label}</button>`).join('')}
      </div>
      <button class="refresh-btn small" onclick="copyText(this, boardMarkdown())" title="Copy this view as a Markdown checklist">Copy list</button>
      <button class="refresh-btn small" onclick="toggleShortcutHelp()" title="Keyboard shortcuts">?</button>
    </div>
  </div>`;
}

function matchesFilter(r, key) {
  const staleDays = ghState.status?.staleDays ?? 14;
  switch (key) {
    case 'attention': return r.risk > 0 && !r.archived;
    case 'critical': return r.alerts.counts.critical > 0 || r.alerts.counts.high > 0;
    case 'dependabot-prs': return r.prs.counts.dependabot > 0;
    case 'open-prs': return r.prs.counts.total > 0;
    case 'no-dependabot': return !r.dependabot.configPresent && !r.archived;
    case 'alerts-off': return r.dependabot.alertsEnabled === false;
    case 'sla': return (r.alerts.slaBreaches || 0) > 0;
    case 'secrets': return (r.secretAlerts || []).length > 0;
    case 'ci-failing': return r.ci?.state === 'failing';
    case 'vulnerable': return r.alerts.counts.total > 0;
    case 'stale': return !r.archived && (r.lastScan.source === 'none' || (r.lastScan.ageDays != null && r.lastScan.ageDays > staleDays));
    case 'clean': return r.risk === 0;
    default: return true;
  }
}

function countFor(key) { return ghState.repos.filter(r => matchesFilter(r, key)).length; }

function setRepoFilterKey(key) {
  repoFilterKey = key;
  setParams({ filter: key === 'attention' ? null : key });
  renderPatch();
}
function setRepoSort(key) {
  repoSort = key;
  setParams({ sort: key === 'risk' ? null : key });
  renderRepoTable();
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.textContent === SORTS.find(s => s.key === key)?.label));
}
function setRepoSearch(value) {
  repoSearch = value;
  setParams({ q: value });
  renderRepoTable();
}

// Selected by switch, not by indexing: repoSort is restored from sessionStorage,
// and a keyed lookup on it is a dynamic dispatch on stored input.
function repoComparator(sort) {
  switch (sort) {
    case 'alerts': return (a, b) => b.alerts.counts.total - a.alerts.counts.total || b.risk - a.risk;
    case 'prs': return (a, b) => b.prs.counts.total - a.prs.counts.total || b.risk - a.risk;
    case 'scan': return (a, b) => (b.lastScan.ageDays ?? 1e9) - (a.lastScan.ageDays ?? 1e9);
    case 'name': return (a, b) => a.fullName.localeCompare(b.fullName);
    default: return (a, b) => b.risk - a.risk || a.fullName.localeCompare(b.fullName);
  }
}

function sortRepos(repos) {
  const comparator = repoComparator(repoSort);
  return [...repos].sort((a, b) => comparator(a, b));
}

function renderRepoTable() {
  const host = $('repo-table');
  if (!host) return;
  const q = repoSearch.trim().toLowerCase();
  let repos = ghState.repos.filter(r => matchesFilter(r, repoFilterKey));
  if (q) repos = repos.filter(r => r.fullName.toLowerCase().includes(q) || (r.language || '').toLowerCase().includes(q));
  repos = sortRepos(repos);

  if (!repos.length) {
    host.innerHTML = `<div class="empty"><div class="icon">✅</div><h3>Nothing here</h3>
      <p>No repos match “${esc(FILTERS.find(f => f.key === repoFilterKey)?.label || repoFilterKey)}”${q ? ` and “${esc(repoSearch)}”` : ''}.</p></div>`;
    return;
  }

  host.innerHTML = `
    <div class="repo-table">
      <div class="repo-head">
        <span>Repository</span><span>Dependabot</span><span>Open alerts</span>
        <span>PRs</span><span>Last scan</span><span>Trend</span><span>Next action</span>
      </div>
      ${repos.map(renderRepoRow).join('')}
    </div>
    <div class="table-footnote">${repos.length} of ${ghState.repos.length} repos · click a row for alert and PR detail</div>`;
}

function dependabotBadges(r) {
  const d = r.dependabot;
  const chips = [];
  chips.push(d.configPresent
    ? `<span class="chip chip-ok" title="${esc(d.configPath)} · ${esc(d.ecosystems.map(e => e.ecosystem).join(', ') || 'no ecosystems parsed')}">config</span>`
    : '<span class="chip chip-off" title="No .github/dependabot.yml — no version-update PRs">no config</span>');
  if (d.alertsEnabled === false) chips.push('<span class="chip chip-bad" title="Dependabot alerts are disabled">alerts off</span>');
  else if (d.alertsEnabled === true) chips.push('<span class="chip chip-ok" title="Dependabot alerts enabled">alerts</span>');
  else chips.push(`<span class="chip chip-unknown" title="${esc(d.alertsError || 'Alert state unknown')}">alerts ?</span>`);
  if (d.securityUpdatesEnabled === true) chips.push('<span class="chip chip-ok" title="Automatic security-fix PRs enabled">auto-fix</span>');
  else if (d.securityUpdatesEnabled === false) chips.push('<span class="chip chip-off" title="Dependabot security updates disabled">no auto-fix</span>');
  return chips.join('');
}

function alertCells(r) {
  const counts = r.alerts.counts;
  const parts = [];
  for (const [sev, short] of [['critical', 'C'], ['high', 'H'], ['medium', 'M'], ['low', 'L']]) {
    if (counts[sev]) parts.push(`<span class="badge badge-${sev}">${counts[sev]}${short}</span>`);
  }
  // Signals from the other two scanners, and the age-budget breach flag
  if ((r.secretAlerts || []).length) {
    parts.push(`<span class="badge badge-critical" title="Leaked secrets">🔑 ${r.secretAlerts.length}</span>`);
  }
  if ((r.codeScanningAlerts || []).length) {
    parts.push(`<span class="badge badge-medium" title="Code-scanning alerts">⚑ ${r.codeScanningAlerts.length}</span>`);
  }
  if (r.alerts.slaBreaches) {
    parts.push(`<span class="badge badge-critical" title="Past its age budget">⏱ ${r.alerts.slaBreaches}</span>`);
  }
  return parts.length ? parts.join(' ') : '<span class="muted">—</span>';
}

function renderRepoRow(r) {
  const open = expandedRepos.has(r.fullName);
  const scanTone = r.lastScan.at ? ageTone(r.lastScan.ageDays, ghState.status.staleDays) : 'red';
  const prCounts = r.prs.counts;
  return `<div class="repo-row-wrap">
    <div class="repo-row ${open ? 'expanded' : ''}" role="button" tabindex="0"
      aria-expanded="${open}" aria-label="${esc(r.fullName)} details" data-repo="${esc(r.fullName)}"
      onclick="toggleRepo('${esc(r.fullName)}')" onkeydown="repoRowKey(event, '${esc(r.fullName)}')">
      <span class="repo-name">
        <span class="expand-icon">${open ? '▾' : '▸'}</span>
        <span class="repo-title">${esc(r.name)}</span>
        <span class="repo-owner">${esc(r.owner)}</span>
        ${r.private ? '<span class="chip chip-dim">private</span>' : ''}
        ${r.archived ? '<span class="chip chip-dim">archived</span>' : ''}
        ${r.language ? `<span class="chip chip-dim">${esc(r.language)}</span>` : ''}
      </span>
      <span class="repo-dependabot">${dependabotBadges(r)}</span>
      <span class="repo-alerts">${alertCells(r)}</span>
      <span class="repo-prs">
        ${prCounts.dependabot ? `<span class="chip chip-bot" title="Dependabot / Renovate PRs">🤖 ${prCounts.dependabot}</span>` : ''}
        ${prCounts.other ? `<span class="chip chip-human" title="Other open PRs">👤 ${prCounts.other}</span>` : ''}
        ${!prCounts.total ? '<span class="muted">—</span>' : ''}
      </span>
      <span class="repo-scan" title="${esc(r.lastScan.label)}${r.lastScan.at ? ` · ${esc(r.lastScan.at)}` : ''}">
        <span class="status-dot ${scanTone}"></span>${relTime(r.lastScan.at)}
      </span>
      <span class="repo-trend" title="Open alerts over time">${sparkline(seriesFor(r.fullName))}</span>
      <span class="repo-action tone-${r.action.tone}">${esc(r.action.text)}</span>
    </div>
    ${open ? renderRepoDetail(r) : ''}
  </div>`;
}

function toggleRepo(fullName) {
  if (expandedRepos.has(fullName)) expandedRepos.delete(fullName);
  else expandedRepos.add(fullName);
  renderRepoTable();
  // Re-rendering drops focus; put it back on the row that was just toggled.
  // Matched on the dataset rather than a selector so repo names need no escaping.
  for (const row of document.querySelectorAll('.repo-row')) {
    if (row.dataset.repo === fullName) { row.focus(); break; }
  }
}

/** Rows are grid containers rather than buttons, so Enter/Space are wired by hand. */
function repoRowKey(event, fullName) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggleRepo(fullName);
}

function renderRepoDetail(r) {
  return `<div class="repo-detail">
    ${r.gaps.length ? `<div class="detail-block">
      <h4>Gaps</h4>
      <div class="gap-list">${r.gaps.map(g => `
        <div class="gap gap-${g.severity}">
          <span class="gap-label">${esc(g.label)}${g.detail ? ` <span class="muted">(${esc(g.detail)})</span>` : ''}</span>
          <span class="gap-hint">${esc(g.hint)}</span>
        </div>`).join('')}</div>
    </div>` : ''}

    ${(r.secretAlerts || []).length ? `<div class="detail-block">
      <h4>Leaked secrets (${r.secretAlerts.length})</h4>
      <div class="alert-list">${r.secretAlerts.map(a => `
        <a class="alert-item" href="${esc(a.url)}" target="_blank" rel="noopener">
          <span class="badge badge-critical">secret</span>
          <span class="alert-pkg">${esc(a.type)}</span>
          <span class="alert-summary">${a.validity === 'active' ? 'Still valid — rotate now' : `validity: ${esc(a.validity)}`}</span>
          <span class="alert-age muted">${a.ageDays}d</span>
        </a>`).join('')}</div>
    </div>` : ''}

    ${r.alerts.list.length ? `<div class="detail-block">
      <h4>Open alerts (${r.alerts.list.length})</h4>
      <div class="alert-list">${r.alerts.list.slice(0, 25).map(a => `
        <a class="alert-item ${a.breachesSla ? 'alert-breach' : ''}" href="${esc(a.url)}" target="_blank" rel="noopener">
          ${severityBadge(a.severity)}
          <span class="alert-pkg">${esc(a.package)}</span>
          <span class="alert-summary">${esc(a.summary)}</span>
          <span class="alert-fix">${a.patchedVersion ? `fix: ${esc(a.patchedVersion)}` : '<span class="muted">no fix yet</span>'}</span>
          <span class="alert-age ${a.breachesSla ? 'stale' : 'muted'}" title="${a.breachesSla ? `Past its ${a.slaDays}d budget` : ''}">${a.ageDays}d</span>
        </a>`).join('')}</div>
      ${r.alerts.list.length > 25 ? `<div class="muted">+${r.alerts.list.length - 25} more…</div>` : ''}
    </div>` : ''}

    ${(r.codeScanningAlerts || []).length ? `<div class="detail-block">
      <h4>Code scanning (${r.codeScanningAlerts.length})</h4>
      <div class="alert-list">${r.codeScanningAlerts.slice(0, 15).map(a => `
        <a class="alert-item" href="${esc(a.url)}" target="_blank" rel="noopener">
          ${severityBadge(a.severity)}
          <span class="alert-pkg">${esc(a.rule)}</span>
          <span class="alert-summary">${esc(a.summary)}</span>
          <span class="alert-fix muted">${esc(a.path || '')}</span>
          <span class="alert-age muted">${a.ageDays}d</span>
        </a>`).join('')}</div>
    </div>` : ''}

    ${r.prs.dependabot.length ? `<div class="detail-block">
      <h4>Dependency update PRs (${r.prs.dependabot.length})${renderMergeBar(r)}</h4>
      <div class="pr-list">${r.prs.dependabot.map(pr => renderPrItem(pr, false, r.fullName)).join('')}</div>
    </div>` : ''}

    ${r.prs.other.length ? `<div class="detail-block">
      <h4>Other open PRs (${r.prs.other.length})</h4>
      <div class="pr-list">${r.prs.other.map(pr => renderPrItem(pr)).join('')}</div>
    </div>` : ''}

    ${(r.dismissedAlerts || []).length ? `<details class="detail-block dismissed-block">
      <summary>Dismissed alerts (${r.dismissedAlerts.length})</summary>
      <div class="alert-list">${r.dismissedAlerts.map(a => `
        <a class="alert-item dismissed" href="${esc(a.url)}" target="_blank" rel="noopener">
          ${severityBadge(a.severity)}
          <span class="alert-pkg">${esc(a.package)}</span>
          <span class="alert-summary">${esc(a.dismissedComment || a.summary)}</span>
          <span class="alert-fix muted">${esc((a.dismissedReason || '').replace(/_/g, ' '))}</span>
          <span class="alert-age muted">by ${esc(a.dismissedBy || '?')} · ${a.dismissedDaysAgo}d</span>
        </a>`).join('')}</div>
    </details>` : ''}

    ${!r.dependabot.configPresent && !r.archived ? renderSetupSnippet(r) : ''}

    <div class="detail-links">
      <a href="${esc(r.url)}" target="_blank" rel="noopener">Repo ↗</a>
      <a href="${esc(r.url)}/security/dependabot" target="_blank" rel="noopener">Dependabot alerts ↗</a>
      <a href="${esc(r.url)}/pulls" target="_blank" rel="noopener">Pull requests ↗</a>
      <a href="${esc(r.url)}/settings/security_analysis" target="_blank" rel="noopener">Security settings ↗</a>
      ${r.ci ? `<a href="${esc(r.ci.url || `${r.url}/actions`)}" target="_blank" rel="noopener" class="tone-${r.ci.state === 'failing' ? 'critical' : 'ok'}">${r.ci.branch} CI: ${r.ci.state} ↗</a>` : ''}
      ${r.packageCount ? `<span class="muted">${r.packageCount} packages indexed</span>` : ''}
      ${r.codeScanning?.lastAnalysisAt ? `<span class="muted">code scanning: ${relTime(r.codeScanning.lastAnalysisAt)}</span>` : ''}
    </div>
    ${r.errors?.length ? `<div class="detail-errors">${r.errors.map(e => `<div>⚠ ${esc(e.scope)}: ${esc(e.message)}</div>`).join('')}</div>` : ''}
  </div>`;
}

function checkChip(checks) {
  if (!checks || checks.state === 'none') return '';
  const map = { passing: ['chip-ok', '✓ CI'], failing: ['chip-bad', '✗ CI'], pending: ['chip-unknown', '● CI'] };
  const [cls, label] = map[checks.state] || ['chip-unknown', 'CI'];
  return `<span class="chip ${cls}" title="${checks.failing} failing, ${checks.pending} pending of ${checks.total}">${label}</span>`;
}

/**
 * Merge controls, shown only when the server reports writes are enabled.
 * Selection is limited to PRs whose CI is green — the point is to clear the
 * safe ones in bulk, not to merge anything unverified.
 */
function renderMergeBar(repo) {
  if (!ghState.status?.allowWrites) return '';
  const mergeable = repo.prs.dependabot.filter(pr => pr.checks?.state === 'passing' && !pr.draft);
  if (!mergeable.length) return '';
  const selected = mergeable.filter(pr => selectedPrs.has(`${repo.fullName}#${pr.number}`)).length;
  return `<span class="merge-bar">
    <button class="refresh-btn small" onclick="event.stopPropagation();selectAllGreen('${esc(repo.fullName)}')">
      Select ${mergeable.length} green
    </button>
    <button class="refresh-btn small merge-go" ${selected ? '' : 'disabled'}
      onclick="event.stopPropagation();mergeSelected('${esc(repo.fullName)}')">
      Merge ${selected || ''} selected
    </button>
  </span>`;
}

function selectAllGreen(fullName) {
  const repo = ghState.repos.find(r => r.fullName === fullName);
  if (!repo) return;
  const green = repo.prs.dependabot.filter(pr => pr.checks?.state === 'passing' && !pr.draft);
  const allSelected = green.every(pr => selectedPrs.has(`${fullName}#${pr.number}`));
  for (const pr of green) {
    const key = `${fullName}#${pr.number}`;
    if (allSelected) selectedPrs.delete(key);
    else selectedPrs.add(key);
  }
  renderRepoTable();
}

function togglePrSelection(event, fullName, number) {
  event.stopPropagation();
  const key = `${fullName}#${number}`;
  if (selectedPrs.has(key)) selectedPrs.delete(key);
  else selectedPrs.add(key);
  renderRepoTable();
}

/**
 * Merge the selected PRs one at a time. Sequential on purpose: merging changes
 * the base branch, so a batch fired in parallel can leave later PRs conflicted.
 */
async function mergeSelected(fullName) {
  const numbers = [...selectedPrs]
    .filter(key => key.startsWith(`${fullName}#`))
    .map(key => Number(key.split('#')[1]));
  if (!numbers.length) return;

  const failures = [];
  for (const number of numbers) {
    try {
      const res = await fetch('/api/gh/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: fullName, number, method: 'squash' })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) failures.push(`#${number}: ${body.error || res.status}`);
      else selectedPrs.delete(`${fullName}#${number}`);
    } catch (e) {
      failures.push(`#${number}: ${e.message}`);
    }
  }

  ghState.repos = [];
  await renderPatch();
  if (failures.length) {
    const host = $('repo-table');
    if (host) host.insertAdjacentHTML('beforebegin',
      `<div class="merge-errors">Could not merge ${failures.length}: ${esc(failures.join(' · '))}</div>`);
  }
}

/** Only bot-authored dependency updates are ever selectable for one-click merge. */
function isUpdatePr(pr) { return pr.kind === 'dependabot' || pr.kind === 'renovate'; }

function renderPrItem(pr, showRepo = false, selectableRepo = null) {
  const stale = (pr.ageDays ?? 0) >= 14;
  const canSelect = selectableRepo && ghState.status?.allowWrites &&
    isUpdatePr(pr) && pr.checks?.state === 'passing' && !pr.draft;
  const checked = canSelect && selectedPrs.has(`${selectableRepo}#${pr.number}`);
  return `<div class="pr-row">
    ${canSelect ? `<input type="checkbox" class="pr-check" ${checked ? 'checked' : ''}
      aria-label="Select PR ${pr.number} for merging"
      onclick="togglePrSelection(event, '${esc(selectableRepo)}', ${pr.number})">` : ''}
    <a class="pr-item" href="${esc(pr.url)}" target="_blank" rel="noopener">
      <span class="pr-num">#${pr.number}</span>
      ${showRepo === true && pr.repo ? `<span class="pr-repo">${esc(pr.repo)}</span>` : ''}
      <span class="pr-title">${esc(pr.title)}</span>
      ${pr.draft ? '<span class="chip chip-dim">draft</span>' : ''}
      ${checkChip(pr.checks)}
      <span class="pr-author muted">${esc(pr.author)}</span>
      <span class="pr-age ${stale ? 'stale' : 'muted'}">${pr.ageDays}d</span>
    </a>
  </div>`;
}

/** Copy-paste starter config for repos with nothing set up. */
function suggestedConfig(r) {
  const eco = ECOSYSTEM_BY_LANGUAGE[(r.language || '').toLowerCase()];
  const blocks = [];
  if (eco) blocks.push(eco);
  blocks.push('github-actions');
  return `version: 2\nupdates:\n${blocks.map(e => `  - package-ecosystem: "${e}"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n`).join('')}`;
}

function renderSetupSnippet(r) {
  const yaml = suggestedConfig(r);
  const newFileUrl = `${r.url}/new/${r.defaultBranch || 'main'}?filename=.github/dependabot.yml&value=${encodeURIComponent(yaml)}`;
  return `<div class="detail-block">
    <h4>Set up Dependabot</h4>
    <pre class="config-snippet">${esc(yaml)}</pre>
    <div class="detail-links">
      <a href="${esc(newFileUrl)}" target="_blank" rel="noopener">Create .github/dependabot.yml ↗</a>
      <button class="refresh-btn small" onclick="event.stopPropagation();copyText(this, ${JSON.stringify(yaml).replace(/"/g, '&quot;')})">Copy YAML</button>
    </div>
  </div>`;
}

function copyText(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  });
}

/**
 * The board as a Markdown checklist. The dashboard is where you decide what to
 * patch; the actual work often happens in an issue or a notes app.
 */
function boardMarkdown() {
  const q = repoSearch.trim().toLowerCase();
  let repos = ghState.repos.filter(r => matchesFilter(r, repoFilterKey));
  if (q) repos = repos.filter(r => r.fullName.toLowerCase().includes(q));
  repos = sortRepos(repos);

  const s = ghState.overview?.summary;
  const lines = [
    `# Patch board — ${new Date().toLocaleDateString()}`,
    s ? `${s.alerts.total} open alerts (${s.alerts.critical}C/${s.alerts.high}H) · ${s.coverage.percent}% Dependabot coverage · ${s.prs.dependabot} update PRs` : '',
    '',
    ...repos.flatMap(r => {
      const bits = [];
      if (r.alerts.counts.total) bits.push(`${r.alerts.counts.total} alerts (${r.alerts.counts.critical}C/${r.alerts.counts.high}H)`);
      if (r.prs.counts.dependabot) bits.push(`${r.prs.counts.dependabot} update PRs`);
      if (r.alerts.slaBreaches) bits.push(`${r.alerts.slaBreaches} past budget`);
      if ((r.secretAlerts || []).length) bits.push(`${r.secretAlerts.length} leaked secrets`);
      return [
        `- [ ] **${r.fullName}** — ${r.action.text}${bits.length ? ` (${bits.join(', ')})` : ''}`,
        ...r.alerts.list.slice(0, 5).map(a =>
          `  - ${a.severity}: ${a.package} — ${a.summary}${a.patchedVersion ? ` → ${a.patchedVersion}` : ''}`)
      ];
    })
  ];
  return lines.filter(l => l !== '').join('\n');
}

// === Keyboard navigation =================================================
// This is a triage tool; triage should not require a mouse.

let focusedRow = -1;

function focusRow(index) {
  const rows = [...document.querySelectorAll('.repo-row')];
  if (!rows.length) return;
  focusedRow = Math.max(0, Math.min(index, rows.length - 1));
  rows[focusedRow].focus();
  rows[focusedRow].scrollIntoView({ block: 'nearest' });
}

function handleShortcut(event) {
  // Never hijack typing, and never fight a modifier chord the browser owns.
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const rows = [...document.querySelectorAll('.repo-row')];
  switch (event.key) {
    case '/':
      event.preventDefault();
      ($('repo-search') || $('pkg-search'))?.focus();
      break;
    case 'j':
      event.preventDefault();
      focusRow(focusedRow + 1);
      break;
    case 'k':
      event.preventDefault();
      focusRow(focusedRow - 1);
      break;
    case 'o': {
      const repo = rows[focusedRow]?.dataset.repo;
      const match = ghState.repos.find(r => r.fullName === repo);
      if (match) window.open(match.url, '_blank', 'noopener');
      break;
    }
    case 'r':
      refreshGitHub(document.querySelector('.refresh-btn'));
      break;
    case '?':
      event.preventDefault();
      toggleShortcutHelp();
      break;
    default:
      break;
  }
}

const SHORTCUTS = [
  ['/', 'Focus search'], ['j / k', 'Move between rows'], ['Enter / Space', 'Expand a row'],
  ['o', 'Open the focused repo on GitHub'], ['r', 'Rescan'], ['?', 'Toggle this help']
];

function toggleShortcutHelp() {
  const existing = document.getElementById('shortcut-help');
  if (existing) { existing.remove(); return; }
  document.body.insertAdjacentHTML('beforeend', `
    <div id="shortcut-help" class="shortcut-help" role="dialog" aria-label="Keyboard shortcuts">
      <h4>Keyboard shortcuts</h4>
      ${SHORTCUTS.map(([key, what]) => `<div><kbd>${esc(key)}</kbd><span>${esc(what)}</span></div>`).join('')}
      <button class="refresh-btn small" onclick="toggleShortcutHelp()">Close</button>
    </div>`);
}

document.addEventListener('keydown', handleShortcut);

function renderSetupScreen() {
  return `<div class="setup-screen">
    <h2>Connect your GitHub account</h2>
    <p>The patch board reads Dependabot alerts, configs and open PRs across every repo your token can see.
       Nothing is written back — the token only needs read access.</p>
    <ol>
      <li>Create a fine-grained PAT with <strong>Repository permissions → Metadata: Read</strong>,
          <strong>Dependabot alerts: Read</strong>, <strong>Pull requests: Read</strong>,
          <strong>Contents: Read</strong>, <strong>Actions: Read</strong>
          (a classic PAT with <code>repo</code> + <code>security_events</code> works too).</li>
      <li>Set it as <code>GITHUB_TOKEN</code> in your <code>.env</code> / compose file.</li>
      <li>Restart the container: <code>docker compose up -d</code></li>
    </ol>
    <pre class="config-snippet">GITHUB_TOKEN=github_pat_xxx
GH_OWNERS=your-username        # optional: limit to these users/orgs
GH_REFRESH_MINUTES=30
GH_STALE_DAYS=14</pre>
    <p><a href="#/audits" onclick="navigate('/audits');return false">Go to the nightly audit dashboard →</a></p>
  </div>`;
}

// === All-PRs view ========================================================

let prKind = 'all';

async function renderPrs() {
  app.innerHTML = '<div class="loading"><div class="spinner"></div>Loading pull requests…</div>';
  let state;
  try { state = await loadGitHub(); } catch (e) { showError('Could not load GitHub data', e.message); return; }
  if (!state.status.configured) { app.innerHTML = renderSetupScreen(); return; }

  const all = [];
  for (const r of state.repos) {
    for (const pr of [...r.prs.dependabot, ...r.prs.other]) all.push({ ...pr, repo: r.fullName });
  }
  const shown = all
    .filter(pr => prKind === 'all' || (prKind === 'dependabot' ? isUpdatePr(pr) : !isUpdatePr(pr)))
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const counts = { all: all.length, dependabot: all.filter(isUpdatePr).length, other: all.filter(pr => !isUpdatePr(pr)).length };
  const failing = shown.filter(pr => pr.checks?.state === 'failing').length;

  app.innerHTML = `
    <div class="patch-header">
      <div>
        <h2 class="patch-title">Open pull requests</h2>
        <div class="patch-sub">${counts.all} open across ${state.repos.length} repos · ${failing} with failing CI</div>
      </div>
      <button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>
    </div>
    <div class="repo-filter">
      ${[['all', 'All'], ['dependabot', 'Dependency updates'], ['other', 'Everything else']].map(([k, label]) =>
    `<button class="repo-btn ${prKind === k ? 'active' : ''}" onclick="setPrKind('${k}')">${label} <span class="filter-count">${counts[k]}</span></button>`).join('')}
    </div>
    ${shown.length
    ? `<div class="pr-list wide">${shown.map(pr => renderPrItem(pr, true, pr.repo)).join('')}</div>`
    : '<div class="empty"><div class="icon">🎉</div><h3>No open pull requests</h3></div>'}`;
}

function setPrKind(kind) { prKind = kind; renderPrs(); }

// === Advisories view =====================================================

async function renderAdvisories() {
  syncStateFromUrl();
  app.innerHTML = '<div class="loading"><div class="spinner"></div>Grouping alerts by advisory…</div>';
  let state;
  try { state = await loadGitHub(); } catch (e) { showError('Could not load GitHub data', e.message); return; }
  if (!state.status.configured) { app.innerHTML = renderSetupScreen(); return; }

  let advisories;
  try { advisories = await api('/api/gh/advisories'); } catch (e) { showError('Could not load advisories', e.message); return; }

  const sev = routeParams().get('severity') || '';
  const shown = sev ? advisories.filter(a => a.severity === sev) : advisories;
  const multi = advisories.filter(a => a.repoCount > 1).length;

  app.innerHTML = `
    <div class="patch-header">
      <div>
        <h2 class="patch-title">Advisories</h2>
        <div class="patch-sub">
          ${advisories.length} distinct advisories across ${state.repos.length} repos
          ${multi ? `· <strong>${multi}</strong> hit more than one repo` : ''}
        </div>
      </div>
      <button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>
    </div>
    <div class="repo-filter">
      ${['', 'critical', 'high', 'medium', 'low'].map(s => `
        <button class="repo-btn ${sev === s ? 'active' : ''}" onclick="setAdvisorySeverity('${s}')">
          ${s || 'All'} <span class="filter-count">${s ? advisories.filter(a => a.severity === s).length : advisories.length}</span>
        </button>`).join('')}
    </div>
    ${shown.length ? `<div class="advisory-list">${shown.map(renderAdvisory).join('')}</div>`
    : '<div class="empty"><div class="icon">✅</div><h3>No open advisories</h3></div>'}`;
}

function setAdvisorySeverity(sev) {
  setParams({ severity: sev || null });
  renderAdvisories();
}

function renderAdvisory(a) {
  const id = a.ghsaId || a.cveId || a.package;
  return `<div class="advisory ${a.repoCount > 1 ? 'advisory-multi' : ''}">
    <div class="advisory-head">
      ${severityBadge(a.severity)}
      <span class="advisory-pkg">${esc(a.package)}</span>
      <span class="advisory-summary">${esc(a.summary)}</span>
      <span class="advisory-count" title="Repositories affected">${a.repoCount} repo${a.repoCount > 1 ? 's' : ''}</span>
    </div>
    <div class="advisory-meta">
      ${a.ghsaId ? `<a href="https://github.com/advisories/${esc(a.ghsaId)}" target="_blank" rel="noopener">${esc(a.ghsaId)}</a>` : ''}
      ${a.cveId ? `<span class="muted">${esc(a.cveId)}</span>` : ''}
      ${a.patchedVersion ? `<span class="alert-fix">fix: ${esc(a.patchedVersion)}</span>` : '<span class="muted">no fix available</span>'}
      <span class="muted">oldest ${a.oldestDays}d</span>
      ${a.breaches ? `<span class="tone-critical">${a.breaches} past budget</span>` : ''}
      <button class="refresh-btn small" onclick="copyText(this, ${JSON.stringify(advisoryMarkdown(a)).replace(/"/g, '&quot;')})">Copy</button>
    </div>
    <div class="advisory-repos">
      ${a.repos.map(r => `<a class="advisory-repo ${r.breachesSla ? 'stale' : ''}" href="${esc(r.url)}" target="_blank" rel="noopener">
        ${esc(r.repo.split('/')[1])}<span class="muted"> ${esc(r.manifest || '')} · ${r.ageDays}d</span>
      </a>`).join('')}
    </div>
    <span class="visually-hidden">${esc(id)}</span>
  </div>`;
}

function advisoryMarkdown(a) {
  const lines = [
    `## ${a.severity.toUpperCase()}: ${a.package} — ${a.summary}`,
    a.ghsaId ? `- Advisory: https://github.com/advisories/${a.ghsaId}` : null,
    a.patchedVersion ? `- Fixed in: ${a.patchedVersion}` : '- No fix available yet',
    `- Affected repos (${a.repoCount}):`,
    ...a.repos.map(r => `  - [ ] ${r.repo}${r.manifest ? ` (${r.manifest})` : ''} — open ${r.ageDays}d`)
  ];
  return lines.filter(Boolean).join('\n');
}

// === Package search ======================================================

async function renderPackages() {
  syncStateFromUrl();
  const query = routeParams().get('q') || '';
  let state;
  try { state = await loadGitHub(); } catch (e) { showError('Could not load GitHub data', e.message); return; }
  if (!state.status.configured) { app.innerHTML = renderSetupScreen(); return; }

  let result = { count: 0, repoCount: 0, results: [], indexed: false };
  try { result = await api(`/api/gh/packages?q=${encodeURIComponent(query)}`); } catch { /* render the empty state */ }

  app.innerHTML = `
    <div class="patch-header">
      <div>
        <h2 class="patch-title">Packages</h2>
        <div class="patch-sub">
          ${result.indexed
    ? `${result.count.toLocaleString()} distinct packages across ${result.repoCount} repos`
    : 'No package index yet — set GH_COLLECT_SBOM=true and rescan'}
        </div>
      </div>
      <button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>
    </div>
    <p class="section-hint">
      Which repos depend on a package, straight from each repo's dependency graph.
      Answers before an advisory exists — and covers packages that never get one.
    </p>
    <input class="search-input wide" id="pkg-search" placeholder="Package name, e.g. lodash"
      value="${esc(query)}" oninput="onPackageSearch(this.value)" autocomplete="off">
    <div id="pkg-results">${renderPackageResults(result, query)}</div>`;

  $('pkg-search')?.focus();
}

let pkgSearchTimer = null;
function onPackageSearch(value) {
  clearTimeout(pkgSearchTimer);
  // Debounced: the index is server-side and every keystroke would be a request.
  pkgSearchTimer = setTimeout(async () => {
    setParams({ q: value });
    try {
      const result = await api(`/api/gh/packages?q=${encodeURIComponent(value)}`);
      const host = $('pkg-results');
      if (host) host.innerHTML = renderPackageResults(result, value);
    } catch { /* leave the previous results in place */ }
  }, 200);
}

function renderPackageResults(result, query) {
  if (!result.indexed) {
    return `<div class="empty"><div class="icon">📦</div><h3>Package index not built</h3>
      <p>Set <code>GH_COLLECT_SBOM=true</code> and rescan to enable cross-repo package search.</p></div>`;
  }
  if (!query.trim()) {
    return '<div class="empty"><div class="icon">🔎</div><h3>Search for a package</h3><p>Type a name to see every repo that depends on it.</p></div>';
  }
  if (!result.results.length) {
    return `<div class="empty"><div class="icon">🤷</div><h3>No match for “${esc(query)}”</h3>
      <p>Nothing in the indexed dependency graphs uses that package.</p></div>`;
  }
  return `<div class="pkg-list">${result.results.map(p => `
    <div class="pkg">
      <div class="pkg-head">
        <span class="chip chip-dim">${esc(p.ecosystem)}</span>
        <span class="pkg-name">${esc(p.name)}</span>
        <span class="pkg-count">${p.repos.length} repo${p.repos.length > 1 ? 's' : ''}</span>
        <button class="refresh-btn small" onclick="copyText(this, ${JSON.stringify(packageMarkdown(p)).replace(/"/g, '&quot;')})">Copy</button>
      </div>
      <div class="pkg-repos">${p.repos.map(r => {
    const repo = ghState.repos.find(x => x.fullName === r.repo);
    return `<a class="pkg-repo" href="${esc(repo?.url || `https://github.com/${r.repo}`)}" target="_blank" rel="noopener">
          ${esc(r.repo.split('/')[1])}<span class="pkg-version">${esc(r.version || '—')}</span>
        </a>`;
  }).join('')}</div>
    </div>`).join('')}</div>`;
}

function packageMarkdown(p) {
  return [`## ${p.ecosystem}:${p.name} — ${p.repos.length} repos`,
    ...p.repos.map(r => `- [ ] ${r.repo} @ ${r.version || 'unknown'}`)].join('\n');
}

// === Timeline ============================================================

async function renderTimeline() {
  app.innerHTML = '<div class="loading"><div class="spinner"></div>Loading history…</div>';
  let state;
  try { state = await loadGitHub(); } catch (e) { showError('Could not load GitHub data', e.message); return; }
  if (!state.status.configured) { app.innerHTML = renderSetupScreen(); return; }

  let rows;
  try { rows = await api('/api/gh/history'); } catch (e) { showError('Could not load history', e.message); return; }

  if (!rows || rows.length < 2) {
    app.innerHTML = `${timelineHeader(rows?.length || 0)}
      <div class="empty"><div class="icon">📈</div><h3>Not enough history yet</h3>
      <p>A snapshot is recorded on every scan. Come back after a few refreshes — or lower
      <code>GH_REFRESH_MINUTES</code> to build the picture faster.</p></div>`;
    return;
  }

  const latest = rows[rows.length - 1];
  const first = rows[0];
  const series = [
    { key: 'critical', label: 'Critical', color: 'var(--red)' },
    { key: 'high', label: 'High', color: 'var(--orange)' },
    { key: 'alerts', label: 'All alerts', color: 'var(--accent)' },
    { key: 'coverage', label: 'Coverage %', color: 'var(--green)' }
  ];

  app.innerHTML = `
    ${timelineHeader(rows.length)}
    <div class="kpi-row">
      ${series.map(s => {
    const now = latest[s.key] ?? 0;
    const then = first[s.key] ?? 0;
    const delta = now - then;
    const better = s.key === 'coverage' ? delta > 0 : delta < 0;
    return `<div class="kpi ${delta === 0 ? '' : better ? 'kpi-ok' : 'kpi-critical'}">
          <div class="kpi-label">${s.label}</div>
          <div class="kpi-value">${now}${s.key === 'coverage' ? '%' : ''}</div>
          <div class="kpi-sub">${delta === 0 ? 'no change' : `${delta > 0 ? '+' : ''}${delta} since ${relTime(first.at)}`}</div>
        </div>`;
  }).join('')}
    </div>
    <div class="section">
      <h3>Open alerts over time</h3>
      ${bigChart(rows)}
    </div>
    <div class="section">
      <h3>Snapshots <span class="count">${rows.length}</span></h3>
      <div class="timeline-rows">
        ${[...rows].reverse().slice(0, 40).map(r => `
          <div class="timeline-row">
            <span class="muted">${new Date(r.at).toLocaleString()}</span>
            <span>${r.repos} repos</span>
            <span>${r.coverage == null ? '—' : `${r.coverage}%`} covered</span>
            <span class="badge badge-critical">${r.critical}C</span>
            <span class="badge badge-high">${r.high}H</span>
            <span class="muted">${r.alerts} alerts · ${r.dependabotPrs} PRs</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function timelineHeader(count) {
  return `<div class="patch-header">
    <div>
      <h2 class="patch-title">Timeline</h2>
      <div class="patch-sub">${count} snapshot${count === 1 ? '' : 's'} · one per scan</div>
    </div>
    <button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>
  </div>`;
}

/** Multi-series line chart as inline SVG — no chart library, no build step. */
function bigChart(rows, { width = 900, height = 200, pad = 28 } = {}) {
  const keys = [
    { key: 'critical', color: 'var(--red)' },
    { key: 'high', color: 'var(--orange)' },
    { key: 'medium', color: 'var(--yellow)' },
    { key: 'low', color: 'var(--accent)' }
  ];
  const max = Math.max(1, ...rows.flatMap(r => keys.map(k => r[k.key] || 0)));
  const stepX = (width - pad * 2) / Math.max(1, rows.length - 1);
  const y = v => height - pad - (v / max) * (height - pad * 2);

  const lines = keys.map(k => {
    const pts = rows.map((r, i) => `${(pad + i * stepX).toFixed(1)},${y(r[k.key] || 0).toFixed(1)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${k.color}" stroke-width="2" stroke-linejoin="round"/>`;
  }).join('');

  const gridlines = [0, 0.5, 1].map(f => {
    const value = Math.round(max * f);
    return `<line x1="${pad}" x2="${width - pad}" y1="${y(value)}" y2="${y(value)}" stroke="var(--border)" stroke-width="1"/>
      <text x="4" y="${y(value) + 4}" fill="var(--text-muted)" font-size="11">${value}</text>`;
  }).join('');

  return `<div class="chart-wrap">
    <svg viewBox="0 0 ${width} ${height}" class="big-chart" role="img"
      aria-label="Open alerts by severity from ${new Date(rows[0].at).toLocaleDateString()} to ${new Date(rows[rows.length - 1].at).toLocaleDateString()}">
      ${gridlines}${lines}
    </svg>
    <div class="chart-legend">
      ${keys.map(k => `<span><i style="background:${k.color}"></i>${k.key}</span>`).join('')}
      <span class="muted">${new Date(rows[0].at).toLocaleDateString()} → ${new Date(rows[rows.length - 1].at).toLocaleDateString()}</span>
    </div>
  </div>`;
}

// === Coverage view =======================================================

async function renderCoverage() {
  app.innerHTML = '<div class="loading"><div class="spinner"></div>Checking Dependabot coverage…</div>';
  let state;
  try { state = await loadGitHub(); } catch (e) { showError('Could not load GitHub data', e.message); return; }
  if (!state.status.configured) { app.innerHTML = renderSetupScreen(); return; }

  const active = state.repos.filter(r => !r.archived);
  const missing = active.filter(r => !r.dependabot.configPresent);
  const alertsOff = active.filter(r => r.dependabot.alertsEnabled === false);
  const noAutoFix = active.filter(r => r.dependabot.securityUpdatesEnabled === false);
  const stale = active.filter(r => r.lastScan.source === 'none' || (r.lastScan.ageDays ?? 0) > state.status.staleDays);
  const covered = active.length - new Set([...missing, ...alertsOff].map(r => r.fullName)).size;

  const section = (title, hint, repos, extra) => `
    <div class="section">
      <h3>${title} <span class="count">${repos.length}</span></h3>
      <p class="section-hint">${hint}</p>
      ${repos.length ? `<div class="coverage-list">${repos.map(r => `
        <div class="coverage-row">
          <a href="${esc(r.url)}" target="_blank" rel="noopener" class="repo-title">${esc(r.fullName)}</a>
          ${r.language ? `<span class="chip chip-dim">${esc(r.language)}</span>` : ''}
          ${r.private ? '<span class="chip chip-dim">private</span>' : ''}
          <span class="muted">pushed ${relTime(r.pushedAt)}</span>
          <span class="muted">last scan ${relTime(r.lastScan.at)}</span>
          ${extra ? extra(r) : ''}
        </div>`).join('')}</div>`
    : '<div class="muted">None — all good.</div>'}
    </div>`;

  app.innerHTML = `
    <div class="patch-header">
      <div>
        <h2 class="patch-title">Dependabot coverage</h2>
        <div class="patch-sub">${covered}/${active.length} active repos fully covered · scanned ${relTime(state.status.fetchedAt)}</div>
      </div>
      <button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>
    </div>
    ${section('No dependabot.yml', 'These repos never get version-update PRs. Add a config to start receiving them.', missing,
    r => `<a class="mini-link" href="${esc(r.url)}/new/${esc(r.defaultBranch || 'main')}?filename=.github/dependabot.yml&value=${encodeURIComponent(suggestedConfig(r))}" target="_blank" rel="noopener">add config ↗</a>`)}
    ${section('Dependabot alerts disabled', 'Vulnerabilities in these repos are invisible — nothing is scanning them.', alertsOff,
    r => `<a class="mini-link" href="${esc(r.url)}/settings/security_analysis" target="_blank" rel="noopener">enable ↗</a>`)}
    ${section('Security updates off', 'Alerts are on, but Dependabot will not open fix PRs automatically.', noAutoFix,
    r => `<a class="mini-link" href="${esc(r.url)}/settings/security_analysis" target="_blank" rel="noopener">enable ↗</a>`)}
    ${section(`No scan in ${state.status.staleDays}+ days`, 'Configured, but nothing has run recently. Check the schedule or the Dependabot job log.', stale,
    r => `<a class="mini-link" href="${esc(r.url)}/network/updates" target="_blank" rel="noopener">job log ↗</a>`)}`;
}
