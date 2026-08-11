/* Patch command center — cross-repo Dependabot coverage, alerts and open PRs.
   Depends on helpers defined in app.js ($, app, api, navigate, severityBadge). */

let ghState = { repos: [], overview: null, status: null };
let repoFilterKey = sessionStorage.getItem('ghFilter') || 'attention';
let repoSort = sessionStorage.getItem('ghSort') || 'risk';
let repoSearch = '';
const expandedRepos = new Set();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

const FILTERS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'critical', label: 'Critical / high' },
  { key: 'dependabot-prs', label: 'Update PRs' },
  { key: 'no-dependabot', label: 'No Dependabot' },
  { key: 'stale', label: 'Stale GitHub scans' },
  { key: 'clean', label: 'Clean' },
  { key: 'all', label: 'All repos' }
];

const SORTS = [
  { key: 'risk', label: 'Risk' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'prs', label: 'PRs' },
  { key: 'scan', label: 'Oldest GitHub scan' },
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
  }
  return ghState;
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
      filter: 'stale', label: 'Stale GitHub scans', value: cov.staleScans.length + cov.neverScanned.length,
      tone: (cov.staleScans.length + cov.neverScanned.length) ? 'warning' : 'ok',
      sub: `${cov.neverScanned.length} never scanned · >${staleDays}d`
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
      <input class="search-input" id="repo-search" placeholder="Filter repos…" value="${esc(repoSearch)}"
        oninput="setRepoSearch(this.value)">
      <div class="sort-bar">
        <span class="sort-label">Sort</span>
        ${SORTS.map(s => `<button class="sort-btn ${repoSort === s.key ? 'active' : ''}"
          onclick="setRepoSort('${s.key}')">${s.label}</button>`).join('')}
      </div>
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
    case 'vulnerable': return r.alerts.counts.total > 0;
    case 'stale': return !r.archived && (r.lastScan.source === 'none' || (r.lastScan.ageDays != null && r.lastScan.ageDays > staleDays));
    case 'clean': return r.risk === 0;
    default: return true;
  }
}

function countFor(key) { return ghState.repos.filter(r => matchesFilter(r, key)).length; }

function setRepoFilterKey(key) {
  repoFilterKey = key;
  sessionStorage.setItem('ghFilter', key);
  renderPatch();
}
function setRepoSort(key) {
  repoSort = key;
  sessionStorage.setItem('ghSort', key);
  renderRepoTable();
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.textContent === SORTS.find(s => s.key === key)?.label));
}
function setRepoSearch(value) { repoSearch = value; renderRepoTable(); }

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
        <span>PRs</span><span>GitHub last scan</span><span>Next action</span>
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

function alertCells(counts) {
  if (!counts.total) return '<span class="muted">—</span>';
  const parts = [];
  for (const [sev, short] of [['critical', 'C'], ['high', 'H'], ['medium', 'M'], ['low', 'L']]) {
    if (counts[sev]) parts.push(`<span class="badge badge-${sev}">${counts[sev]}${short}</span>`);
  }
  return parts.join(' ');
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
      <span class="repo-alerts">${alertCells(r.alerts.counts)}</span>
      <span class="repo-prs">
        ${prCounts.dependabot ? `<span class="chip chip-bot" title="Dependabot / Renovate PRs">🤖 ${prCounts.dependabot}</span>` : ''}
        ${prCounts.other ? `<span class="chip chip-human" title="Other open PRs">👤 ${prCounts.other}</span>` : ''}
        ${!prCounts.total ? '<span class="muted">—</span>' : ''}
      </span>
      <span class="repo-scan" title="${esc(r.lastScan.label)}${r.lastScan.at ? ` · ${esc(r.lastScan.at)}` : ''}">
        <span class="status-dot ${scanTone}"></span>${relTime(r.lastScan.at)}
      </span>
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

    ${r.alerts.list.length ? `<div class="detail-block">
      <h4>Open alerts (${r.alerts.list.length})</h4>
      <div class="alert-list">${r.alerts.list.slice(0, 25).map(a => `
        <a class="alert-item" href="${esc(a.url)}" target="_blank" rel="noopener">
          ${severityBadge(a.severity)}
          <span class="alert-pkg">${esc(a.package)}</span>
          <span class="alert-summary">${esc(a.summary)}</span>
          <span class="alert-fix">${a.patchedVersion ? `fix: ${esc(a.patchedVersion)}` : '<span class="muted">no fix yet</span>'}</span>
          <span class="alert-age muted">${a.ageDays}d</span>
        </a>`).join('')}</div>
      ${r.alerts.list.length > 25 ? `<div class="muted">+${r.alerts.list.length - 25} more…</div>` : ''}
    </div>` : ''}

    ${r.prs.dependabot.length ? `<div class="detail-block">
      <h4>Dependency update PRs (${r.prs.dependabot.length})</h4>
      <div class="pr-list">${r.prs.dependabot.map(pr => renderPrItem(pr)).join('')}</div>
    </div>` : ''}

    ${r.prs.other.length ? `<div class="detail-block">
      <h4>Other open PRs (${r.prs.other.length})</h4>
      <div class="pr-list">${r.prs.other.map(pr => renderPrItem(pr)).join('')}</div>
    </div>` : ''}

    ${!r.dependabot.configPresent && !r.archived ? renderSetupSnippet(r) : ''}

    <div class="detail-links">
      <a href="${esc(r.url)}" target="_blank" rel="noopener">Repo ↗</a>
      <a href="${esc(r.url)}/security/dependabot" target="_blank" rel="noopener">Dependabot alerts ↗</a>
      <a href="${esc(r.url)}/pulls" target="_blank" rel="noopener">Pull requests ↗</a>
      <a href="${esc(r.url)}/settings/security_analysis" target="_blank" rel="noopener">Security settings ↗</a>
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

function renderPrItem(pr, showRepo = false) {
  const stale = (pr.ageDays ?? 0) >= 14;
  return `<a class="pr-item" href="${esc(pr.url)}" target="_blank" rel="noopener">
    <span class="pr-num">#${pr.number}</span>
    ${showRepo === true && pr.repo ? `<span class="pr-repo">${esc(pr.repo)}</span>` : ''}
    <span class="pr-title">${esc(pr.title)}</span>
    ${pr.draft ? '<span class="chip chip-dim">draft</span>' : ''}
    ${checkChip(pr.checks)}
    <span class="pr-author muted">${esc(pr.author)}</span>
    <span class="pr-age ${stale ? 'stale' : 'muted'}">${pr.ageDays}d</span>
  </a>`;
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

function renderSetupScreen() {
  return `<div class="setup-screen">
    <h2>Connect your GitHub account</h2>
    <p>The patch board reads Dependabot alerts, configs and open PRs across every repo your token can see.
       Nothing is written back — the token only needs read access.</p>
    <ol>
      <li>Create a fine-grained PAT with <strong>Repository permissions → Metadata: Read</strong>,
          <strong>Dependabot alerts: Read</strong>, <strong>Pull requests: Read</strong>,
          <strong>Contents: Read</strong>, <strong>Actions: Read</strong>, <strong>Administration: Read</strong>
          (a classic PAT with <code>repo</code> + <code>security_events</code> works too).</li>
      <li>Paste it on the <a href="#/settings" onclick="navigate('/settings');return false"><strong>Settings page</strong></a> — no restart needed.</li>
    </ol>
    <p class="muted">(Setting <code>GITHUB_TOKEN</code> in the environment still works too.)</p>
    <p><a href="#/settings" onclick="navigate('/settings');return false" class="refresh-btn" style="display:inline-block;text-decoration:none">Open Settings →</a></p>
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
  const isBot = pr => pr.kind === 'dependabot' || pr.kind === 'renovate';
  const shown = all
    .filter(pr => prKind === 'all' || (prKind === 'dependabot' ? isBot(pr) : !isBot(pr)))
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const counts = { all: all.length, dependabot: all.filter(isBot).length, other: all.filter(pr => !isBot(pr)).length };
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
    ? `<div class="pr-list wide">${shown.map(pr => renderPrItem(pr, true)).join('')}</div>`
    : '<div class="empty"><div class="icon">🎉</div><h3>No open pull requests</h3></div>'}`;
}

function setPrKind(kind) { prKind = kind; renderPrs(); }

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

// === Settings view =======================================================

async function renderSettings() {
  let s = { github: {} };
  try { s = await api('/api/settings'); } catch { /* render with unknowns */ }
  const gh = s.github || {};
  const status = gh.configured
    ? `<span class="ok-text">Connected${gh.viewer ? ` as <strong>${esc(gh.viewer.login)}</strong>` : ''}</span>
       <span class="muted"> · token ${esc(gh.tokenTail || '')} from ${gh.source === 'settings' ? 'this page' : 'the environment'}</span>`
    : '<span class="muted">Not connected — paste a token below.</span>';

  const patUrl = 'https://github.com/settings/personal-access-tokens/new'
    + '?name=patch-board-readonly'
    + '&description=' + encodeURIComponent('Read-only token for the Patch Board dashboard. Never used to write.')
    + '&metadata=read&contents=read&pull_requests=read&actions=read&administration=read&vulnerability_alerts=read&security_events=read';

  app.innerHTML = `<div class="setup-screen">
    <h2>Settings</h2>
    <div class="settings-card">
      <h3>GitHub token</h3>
      <p>${status}</p>
      <p class="muted">Read-only. Never written back to GitHub. Stored only on this box; never displayed again.</p>

      ${gh.configured ? '<h4>What this token can see</h4><div id="access-grid" class="access-grid"><span class="muted">Checking…</span></div>' : ''}

      <h4>Create it on GitHub</h4>
      <p><a class="refresh-btn" style="display:inline-block;text-decoration:none" href="${patUrl}"
            target="_blank" rel="noopener">Create token on GitHub ↗</a>
         <span class="muted"> — form opens pre-filled</span></p>
      <ol class="token-steps">
        <li>Repository access: <strong>All repositories</strong>.</li>
        <li>Check all six permissions really are <strong>Read-only</strong> (same six as the grid above — GitHub may not
            pre-fill every one); everything else No access. The grid catches anything missing.</li>
        <li>Pick an expiration → <strong>Generate</strong>.</li>
        <li>Copy the <code>github_pat_…</code> and paste it below — GitHub shows it once.</li>
      </ol>

      <div class="settings-row">
        <input type="password" id="token-input" placeholder="github_pat_… or ghp_…" autocomplete="off" spellcheck="false">
        <button class="refresh-btn" id="token-save" onclick="saveToken()">Save & connect</button>
      </div>
      <div id="token-result"></div>
      <p class="muted" style="margin-top:10px">When the token expires, repeat these steps and paste the new one —
         it takes effect immediately, no restart.</p>
      ${gh.source === 'settings' ? `<p class="muted" style="margin-top:10px">
        <a href="#" onclick="clearToken();return false">Remove saved token</a>
        ${gh.envTokenPresent ? ' (falls back to the environment token)' : ' (disconnects GitHub views)'}</p>` : ''}
    </div>
  </div>`;
  if (gh.configured) loadAccessGrid();
}

const ACCESS_ROWS = [
  ['metadata', 'Repo list', 'nothing works without it'],
  ['dependabot_alerts', 'Dependabot alerts', 'the vulnerability columns'],
  ['pull_requests', 'Pull requests', 'PR + CI columns'],
  ['contents', 'Contents', 'dependabot.yml detection'],
  ['actions', 'Actions', 'last-scan timestamps'],
  ['administration', 'Administration', 'alerts-enabled / security-updates flags'],
  ['code_scanning', 'Code scanning', 'CodeQL status + analysis times']
];

async function loadAccessGrid() {
  const el = document.getElementById('access-grid');
  if (!el) return;
  try {
    const a = await api('/api/settings/access');
    el.innerHTML = ACCESS_ROWS.map(([key, label, consequence]) => {
      const st = a.access[key];
      const icon = st === 'ok' ? '<span class="ok-text">✓</span>' : st === 'denied' ? '<span class="err-text">✗</span>' : '<span class="muted">?</span>';
      const note = st === 'ok' ? '' : ` <span class="muted">— missing: ${consequence}</span>`;
      return `<div class="access-row">${icon} <strong>${label}</strong>${note}</div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<span class="err-text">Check failed: ${esc(e.message)}</span>`;
  }
}

async function postSettingsToken(token) {
  const res = await fetch('/api/settings/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  return { ok: res.ok, body: await res.json() };
}

async function saveToken() {
  const input = document.getElementById('token-input');
  const out = document.getElementById('token-result');
  const btn = document.getElementById('token-save');
  const token = (input.value || '').trim();
  if (!token) { out.innerHTML = '<p class="err-text">Paste a token first.</p>'; return; }
  btn.disabled = true; btn.textContent = 'Validating…';
  try {
    const { ok, body } = await postSettingsToken(token);
    if (!ok) {
      out.innerHTML = `<p class="err-text">${esc(body.error || 'Failed')}</p>`;
    } else {
      input.value = '';
      out.innerHTML = `<p class="ok-text">Connected as <strong>${esc(body.viewer.login)}</strong>. First scan is running — the patch board fills in shortly.</p>`;
      setTimeout(() => renderSettings(), 3000); // re-render → access grid re-checks the new token
    }
  } catch (e) {
    out.innerHTML = `<p class="err-text">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Save & connect';
  }
}

async function clearToken() {
  const { ok, body } = await postSettingsToken('');
  if (ok) renderSettings();
  else document.getElementById('token-result').innerHTML = `<p class="err-text">${esc(body.error || 'Failed')}</p>`;
}
