/* Posture, Trends, History, Findings and Calendar.

   Every view here reads the GitHub collector. Two kinds of history exist and the
   UI never blurs them: `recorded` is the local snapshot series, which starts the
   first time this dashboard runs, and `derived` is reconstructed from the dates
   carried by currently-open alerts and PRs — complete for what is open now, but a
   floor for the past, because anything already fixed left no trace to count.
   Depends on helpers in app.js. */

// === Posture =============================================================

const POSTURE_FEATURES = [
  { key: 'dependabotAlerts', label: 'Dependabot alerts', why: 'Without this nothing scans the repo for vulnerable dependencies.', fix: 'settings/security_analysis' },
  { key: 'dependabotConfig', label: 'dependabot.yml', why: 'Without a config there are no scheduled version-update PRs.', fix: null },
  { key: 'securityUpdates', label: 'Security updates', why: 'Alerts are raised but no fix PR is opened automatically.', fix: 'settings/security_analysis' },
  { key: 'codeScanning', label: 'Code scanning', why: 'No CodeQL analysis of the repo’s own source.', fix: 'security/code-scanning' },
  { key: 'secretScanning', label: 'Secret scanning', why: 'Committed credentials are not detected.', fix: 'settings/security_analysis' },
  { key: 'pushProtection', label: 'Push protection', why: 'Secrets can still be pushed to the remote.', fix: 'settings/security_analysis' }
];

let postureFilter = sessionStorage.getItem('postureFilter') || 'all';

async function renderPosture() {
  showLoading('Reading security posture…');
  let p;
  try { p = await api('/api/gh/posture'); } catch (e) { return renderNeedsGitHub(e); }

  const unknownTotal = POSTURE_FEATURES.reduce((n, f) => n + (p.features[f.key]?.unknown?.length || 0), 0);

  const tiles = POSTURE_FEATURES.map(f => {
    const t = p.features[f.key] || { enabled: [], disabled: [], unknown: [] };
    const on = t.enabled.length, off = t.disabled.length, unknown = t.unknown.length;
    const tone = off ? 'critical' : unknown ? 'warning' : 'ok';
    const pct = p.activeCount ? Math.round((on / p.activeCount) * 100) : 0;
    return `<div class="posture-tile posture-${tone}">
      <div class="posture-tile-head">
        <span class="posture-label">${esc(f.label)}</span>
        <span class="posture-pct">${pct}%</span>
      </div>
      <div class="posture-meter"><div class="posture-meter-fill tone-${tone}" style="width:${pct}%"></div></div>
      <div class="posture-counts">
        <span class="ok-text">${on} on</span>
        ${off ? `<span class="err-text">${off} off</span>` : ''}
        ${unknown ? `<span class="muted" title="This token cannot read the setting on these repos">${unknown} not visible</span>` : ''}
      </div>
      ${off ? `<div class="posture-why">${esc(f.why)}</div>` : ''}
    </div>`;
  }).join('');

  const gapRows = p.gaps.length ? p.gaps.map(g => `
    <button class="gap-summary gap-${esc(g.severity)} ${postureFilter === g.id ? 'active' : ''}"
      data-gap="${esc(g.id)}" onclick="setPostureFilter('${jsAttr(g.id)}')" aria-pressed="${postureFilter === g.id}">
      <span class="gap-summary-count">${g.repos.length}</span>
      <span class="gap-summary-label">${esc(g.label)}</span>
    </button>`).join('') : '<div class="muted">No open gaps — every active repo is configured and patched.</div>';

  app.innerHTML = `
    ${viewHeader('Security posture', `${p.activeCount} active repos${p.archivedCount ? ` · ${p.archivedCount} archived hidden` : ''} · scanned ${esc(relTime(p.dataAsOf))}`)}
    ${unknownTotal ? noteBanner(`${unknownTotal} settings are not visible to this token. Add the missing read permissions on <a href="#/settings" onclick="navigate('/settings');return false">Settings</a> to see them — "not visible" is not the same as "off".`, 'warn') : ''}
    <div class="posture-grid">${tiles}</div>
    <div class="section">
      <h3>Open gaps</h3>
      <p class="section-hint">Click one to filter the table. ${p.gaps.length ? 'Each repo can appear in more than one.' : ''}</p>
      <div class="gap-summary-row">
        ${p.gaps.length ? `<button class="gap-summary ${postureFilter === 'all' ? 'active' : ''}" data-gap="all" onclick="setPostureFilter('all')" aria-pressed="${postureFilter === 'all'}">
          <span class="gap-summary-count">${p.repos.length}</span><span class="gap-summary-label">All repos</span></button>` : ''}
        ${gapRows}
      </div>
    </div>
    <div class="section">
      <h3>Per repo</h3>
      <div id="posture-table"></div>
    </div>`;

  window._posture = p;
  renderPostureTable();
}

function setPostureFilter(key) {
  postureFilter = postureFilter === key && key !== 'all' ? 'all' : key;
  sessionStorage.setItem('postureFilter', postureFilter);
  // Matched on the gap id itself: substring-matching the handler string would
  // light two chips as soon as one gap id contained another.
  document.querySelectorAll('.gap-summary').forEach(b => {
    const active = b.dataset.gap === postureFilter;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  renderPostureTable();
}

/**
 * `short` is shown next to the chip on narrow screens, where the table header is
 * hidden — otherwise a row collapses to five identical "on" chips whose only
 * labelling is a title attribute, which does not exist on touch.
 */
function flagCell(value, label, short) {
  const tag = short ? `<span class="flag-name">${esc(short)}</span>` : '';
  if (value === true) return `${tag}<span class="chip chip-ok" title="${esc(label)} enabled">on</span>`;
  if (value === false) return `${tag}<span class="chip chip-bad" title="${esc(label)} disabled">off</span>`;
  return `${tag}<span class="chip chip-unknown" title="This token cannot read ${esc(label)} for this repo">?</span>`;
}

function renderPostureTable() {
  const host = $('posture-table');
  const p = window._posture;
  if (!host || !p) return;

  const repos = postureFilter === 'all'
    ? p.repos
    : p.repos.filter(r => r.gaps.some(g => g.id === postureFilter));

  if (!repos.length) {
    host.innerHTML = '<div class="empty"><div class="icon">✅</div><h3>No repos with that gap</h3></div>';
    return;
  }

  host.innerHTML = `<div class="posture-table">
    <div class="posture-head">
      <span>Repository</span><span>Alerts</span><span>Alerts on</span><span>Config</span>
      <span>Auto-fix</span><span>Code scan</span><span>Secrets</span><span>Next action</span>
    </div>
    ${repos.map(r => `<div class="posture-row">
      <span class="repo-name">
        <a href="${esc(r.url)}" target="_blank" rel="noopener" class="repo-title">${esc(r.fullName)}</a>
        ${r.private ? '<span class="chip chip-dim">private</span>' : ''}
        ${r.language ? `<span class="chip chip-dim">${esc(r.language)}</span>` : ''}
      </span>
      <span>${r.alerts.total
    ? SEVERITY_ORDER.filter(s => r.alerts[s]).map(s => `<span class="badge badge-${s}">${r.alerts[s]}${s[0].toUpperCase()}</span>`).join(' ')
    : '<span class="muted">—</span>'}</span>
      <span>${flagCell(r.dependabot.alertsEnabled, 'Dependabot alerts', 'Alerts')}</span>
      <span>${flagCell(r.dependabot.configPresent, 'dependabot.yml', 'Config')}</span>
      <span>${flagCell(r.dependabot.securityUpdatesEnabled, 'security updates', 'Auto-fix')}</span>
      <span>${flagCell(r.codeScanning?.enabled, 'code scanning', 'Code scan')}</span>
      <span>${flagCell(r.secretScanning?.enabled, 'secret scanning', 'Secrets')}</span>
      <span class="repo-action tone-${esc(r.action.tone)}">${esc(r.action.text)}</span>
    </div>`).join('')}
  </div>
  <div class="table-footnote">${repos.length} of ${p.repos.length} repos${postureFilter !== 'all' ? ' · filtered' : ''} · “?” means this token cannot read the setting</div>`;
}

// === Trends ==============================================================

let trendDays = parseInt(sessionStorage.getItem('trendDays'), 10) || 90;
let trendsRender = 0;

async function renderTrends() {
  // The range buttons re-enter this without going through route(), so it drops
  // its own Chart instances. Tearing down *before* the await let two impatient
  // clicks interleave and strand the loser's charts on detached canvases, so
  // the teardown happens only once this run is known to be the current one.
  const renderId = ++trendsRender;
  showLoading('Building trends…');
  let t;
  try { t = await api(`/api/gh/trends?days=${trendDays}`); } catch (e) { return renderNeedsGitHub(e); }
  if (renderId !== trendsRender) return;   // a later click already took over
  destroyCharts();

  const d = t.derived;
  const recorded = t.recorded.snapshots || [];
  // Read the change off the backlog series itself. The old tile subtracted
  // merged PRs from raised alerts — different units — and reported a healthy
  // negative number while the chart underneath showed the backlog climbing.
  const net = d.backlogChange ?? 0;

  app.innerHTML = `
    ${viewHeader('Trends', `Last ${trendDays} days · scanned ${esc(relTime(t.dataAsOf))}`)}
    <div class="range-selector" role="group" aria-label="Time range">
      ${[7, 30, 90, 180].map(n => `<button class="range-btn ${trendDays === n ? 'active' : ''}"
        aria-pressed="${trendDays === n}" onclick="setTrendDays(${n})">${n}d</button>`).join('')}
    </div>

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Alerts raised</div><div class="kpi-value">${d.totals.raised}</div>
        <div class="kpi-sub">in this window, still open</div></div>
      <div class="kpi kpi-ok"><div class="kpi-label">Updates merged</div><div class="kpi-value">${d.totals.merges}</div>
        <div class="kpi-sub">dependency PRs only${d.totals.otherMerges ? ' · human PRs not counted' : ''}</div></div>
      <div class="kpi ${net > 0 ? 'kpi-warning' : net < 0 ? 'kpi-ok' : ''}"><div class="kpi-label">Open backlog change</div>
        <div class="kpi-value">${net > 0 ? '+' : ''}${net}</div>
        <div class="kpi-sub">${net > 0 ? 'backlog grew over this window' : net < 0 ? 'backlog shrank' : 'backlog flat'}</div></div>
      <div class="kpi"><div class="kpi-label">Open now</div><div class="kpi-value">${d.backlog.total[d.backlog.total.length - 1] ?? 0}</div>
        <div class="kpi-sub">${SEVERITY_ORDER.map(s => `${d.backlog[s][d.backlog[s].length - 1] ?? 0}${s[0].toUpperCase()}`).join(' · ')}</div></div>
    </div>

    <div class="chart-box">
      <h3>Open alert backlog</h3>
      <p class="section-hint">Alerts that are open <em>today</em>, plotted against the day each was raised.
        Anything already fixed is not counted, so earlier points are a floor rather than the true backlog on that day.</p>
      <div class="chart-canvas-wrap"><canvas id="backlogChart"></canvas></div>
    </div>

    <div class="chart-box">
      <h3>Patch activity</h3>
      <p class="section-hint">Alerts raised against dependency PRs merged, per day. Human PRs are excluded — they are not dependency updates.</p>
      <div class="chart-canvas-wrap"><canvas id="activityChart"></canvas></div>
      ${mergeCoverageNote(t.mergeCoverage)}
    </div>

    <div class="chart-box">
      <h3>Recorded scan history</h3>
      ${recorded.length >= 2
    ? '<p class="section-hint">The true series, measured at each scan — not reconstructed.</p><div class="chart-canvas-wrap"><canvas id="recordedChart"></canvas></div>'
    : `<div class="empty compact"><div class="icon">⏱</div>
         <h3>${recorded.length ? plural(recorded.length, 'scan') + ' recorded so far' : 'No scans recorded yet'}</h3>
         <p>This dashboard snapshots every scan locally, because GitHub cannot answer “how many alerts were open last week”.
            Two points are needed to draw a line; the next scan runs within ${t.refreshMinutes || 30} minutes,
            and the charts above cover the meantime.</p></div>`}
    </div>`;

  drawBacklogChart(d);
  drawActivityChart(d);
  if (recorded.length >= 2) drawRecordedChart(recorded);
}

function setTrendDays(days) {
  trendDays = days;
  sessionStorage.setItem('trendDays', String(days));
  renderTrends();
}

/**
 * The collector keeps at most N merged PRs per repo, so a busy repo's older
 * merges are simply absent. Saying so is the difference between a trend and a
 * sampling artifact presented as one.
 */
function mergeCoverageNote(coverage) {
  if (!coverage?.truncatedRepos?.length) return '';
  const n = coverage.truncatedRepos.length;
  const since = coverage.completeSince ? shortDate(coverage.completeSince) : null;
  return `<div class="note note-warn">Merge counts are undercounted before${since ? ` ${esc(since)}` : ' the start of this window'}:
    ${plural(n, 'repo')} merged more than the ${coverage.perRepoLimit} pull requests kept per repo
    (${esc(coverage.truncatedRepos.slice(0, 3).join(', '))}${n > 3 ? `, +${n - 3} more` : ''}).
    Earlier weeks look quieter than they were.</div>`;
}

function axisLabels(days) {
  return days.map(d => shortDate(d));
}

/**
 * Chart.js is vendored locally, so this should never fire — but a blank chart
 * frame with no explanation is exactly the failure the CDN used to produce.
 */
function chartReady(canvas) {
  if (!canvas) return false;
  if (window.Chart) return true;
  const box = canvas.closest('.chart-box') || canvas.parentElement;
  if (box) box.insertAdjacentHTML('beforeend',
    '<div class="chart-missing">Charts unavailable — /vendor/chart.umd.min.js did not load.</div>');
  canvas.remove();
  return false;
}

function drawBacklogChart(d) {
  const canvas = $('backlogChart');
  if (!chartReady(canvas)) return;
  charts.push(new Chart(canvas, {
    type: 'line',
    data: {
      labels: axisLabels(d.days),
      datasets: SEVERITY_ORDER
        .filter(sev => d.backlog[sev].some(v => v > 0))
        .map(sev => ({
          label: sev[0].toUpperCase() + sev.slice(1),
          data: d.backlog[sev],
          borderColor: CHART_COLORS[sev],
          backgroundColor: CHART_COLORS[sev] + '77',
          fill: true, tension: .25, pointRadius: 0, pointHitRadius: 12, borderWidth: 1.5
        }))
    },
    options: { ...CHART_BASE, scales: { ...CHART_BASE.scales, y: { ...CHART_BASE.scales.y, stacked: true } } }
  }));
}

function drawActivityChart(d) {
  const canvas = $('activityChart');
  if (!chartReady(canvas)) return;
  charts.push(new Chart(canvas, {
    type: 'bar',
    data: {
      labels: axisLabels(d.days),
      datasets: [
        { label: 'Alerts raised', data: d.raised.total, backgroundColor: CHART_COLORS.critical + 'cc', borderRadius: 2 },
        { label: 'Dependency PRs merged', data: d.merges, backgroundColor: CHART_COLORS.merged + 'cc', borderRadius: 2 }
      ]
    },
    options: CHART_BASE
  }));
}

function drawRecordedChart(snapshots) {
  const canvas = $('recordedChart');
  if (!chartReady(canvas)) return;
  charts.push(new Chart(canvas, {
    type: 'line',
    data: {
      labels: snapshots.map(s => shortDate(s.at)),
      datasets: [
        {
          label: 'Open alerts', data: snapshots.map(s => s.alerts.total),
          borderColor: CHART_COLORS.total, backgroundColor: CHART_COLORS.total + '33',
          fill: true, tension: .25, pointRadius: 3, yAxisID: 'y'
        },
        {
          label: 'Dependabot coverage %', data: snapshots.map(s => s.coverage.percent),
          borderColor: CHART_COLORS.coverage, borderDash: [4, 3], fill: false, tension: .25, pointRadius: 3, yAxisID: 'y1'
        }
      ]
    },
    options: {
      ...CHART_BASE,
      scales: {
        ...CHART_BASE.scales,
        y1: { position: 'right', min: 0, max: 100, ticks: { color: '#8b949e' }, grid: { drawOnChartArea: false } }
      }
    }
  }));
}

// === History =============================================================

let historyKind = sessionStorage.getItem('historyKind') || 'all';
let historyDays = parseInt(sessionStorage.getItem('historyDays'), 10) || 30;
let historySearch = '';

async function renderHistory() {
  showLoading('Loading patch history…');
  let merges, scans;
  try {
    [merges, scans] = await Promise.all([
      api(`/api/gh/merges?days=${historyDays}`),
      api(`/api/gh/history?days=${historyDays}&limit=60`)
    ]);
  } catch (e) { return renderNeedsGitHub(e); }

  window._merges = merges;
  const botCount = merges.filter(isBotMerge).length;

  app.innerHTML = `
    ${viewHeader('History', `<span id="history-count">${plural(merges.length, 'merged pull request')}</span> in the last ${historyDays} days`)}
    <div class="range-selector" role="group" aria-label="Time range">
      ${[7, 30, 90].map(n => `<button class="range-btn ${historyDays === n ? 'active' : ''}"
        aria-pressed="${historyDays === n}" onclick="setHistoryDays(${n})">${n}d</button>`).join('')}
    </div>
    <div class="patch-controls">
      <div class="repo-filter">
        ${[['all', 'Everything', merges.length], ['dependabot', 'Dependency updates', botCount], ['other', 'Everything else', merges.length - botCount]]
    .map(([k, label, count]) => `<button class="repo-btn ${historyKind === k ? 'active' : ''}"
      aria-pressed="${historyKind === k}" onclick="setHistoryKind('${k}')">${label} <span class="filter-count">${count}</span></button>`).join('')}
      </div>
      <div class="patch-controls-row">
        <input class="search-input" id="history-search" placeholder="Filter by repo, package or title…"
          value="${esc(historySearch)}" aria-label="Filter merged pull requests">
      </div>
    </div>
    <div id="history-list"></div>
    ${renderScanLog(scans)}`;

  const input = $('history-search');
  if (input) input.addEventListener('input', debounce(e => { historySearch = e.target.value; renderHistoryList(); }, 150));
  renderHistoryList();
}

function isBotMerge(m) { return m.kind === 'dependabot' || m.kind === 'renovate'; }

function setHistoryKind(kind) {
  historyKind = kind;
  sessionStorage.setItem('historyKind', kind);
  document.querySelectorAll('.repo-filter .repo-btn').forEach(b => {
    const active = b.getAttribute('onclick') === `setHistoryKind('${kind}')`;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  renderHistoryList();
}

function setHistoryDays(days) {
  historyDays = days;
  sessionStorage.setItem('historyDays', String(days));
  renderHistory();
}

function renderHistoryList() {
  const host = $('history-list');
  if (!host) return;
  const q = historySearch.trim().toLowerCase();

  let items = window._merges || [];
  if (historyKind === 'dependabot') items = items.filter(isBotMerge);
  else if (historyKind === 'other') items = items.filter(m => !isBotMerge(m));
  if (q) {
    items = items.filter(m => m.repo.toLowerCase().includes(q) ||
      (m.title || '').toLowerCase().includes(q) ||
      (m.bump?.package || '').toLowerCase().includes(q));
  }

  if (!items.length) {
    const el = $('history-count');
    if (el) el.textContent = `0 of ${plural((window._merges || []).length, 'merged pull request')}`;
    host.innerHTML = `<div class="empty"><div class="icon">🔍</div><h3>Nothing matches</h3>
      <p>${q ? `No merged PRs matching “${esc(historySearch)}”` : 'No merged pull requests in this window'}.</p></div>`;
    return;
  }

  const byDay = new Map();
  for (const m of items) {
    const day = (m.mergedAt || '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }

  const countEl = $('history-count');
  if (countEl) {
    countEl.textContent = items.length === (window._merges || []).length
      ? plural(items.length, 'merged pull request')
      : `${items.length} of ${plural((window._merges || []).length, 'merged pull request')}`;
  }

  host.innerHTML = [...byDay.entries()].map(([day, list]) => `
    <div class="day-group">
      <div class="day-heading"><span class="day-date">${esc(shortDate(day))}</span>
        <span class="day-count">${plural(list.length, 'merge')}</span></div>
      <div class="pr-list wide">${list.map(m => `
        <a class="pr-item" href="${esc(m.url)}" target="_blank" rel="noopener">
          <span class="pr-num">#${m.number}</span>
          <span class="pr-repo">${esc(m.repo)}</span>
          <span class="pr-title">${esc(m.title)}</span>
          ${m.bump ? `<span class="chip chip-dim" title="${esc(m.bump.from)} → ${esc(m.bump.to)}">${esc(m.bump.package)}</span>` : ''}
          <span class="chip ${isBotMerge(m) ? 'chip-bot' : 'chip-human'}">${isBotMerge(m) ? '🤖' : '👤'} ${esc(m.author)}</span>
        </a>`).join('')}</div>
    </div>`).join('');
}

function renderScanLog(scans) {
  const snapshots = scans.snapshots || [];
  const meta = scans.meta || {};
  const rows = snapshots.map(s => {
    const d = s.delta;
    const sign = n => (n > 0 ? `+${n}` : String(n));
    const tone = !d ? 'flat' : d.alerts.total > 0 ? 'worse' : d.alerts.total < 0 ? 'better' : 'flat';
    return `<div class="scan-row scan-${tone}">
      <span class="scan-time" title="${esc(s.at)}">${esc(relTime(s.at))}</span>
      <span class="scan-metric">${s.repoCount} repos</span>
      <span class="scan-metric">${s.alerts.total} alerts${d && d.alerts.total ? ` <span class="delta ${tone}">${sign(d.alerts.total)}</span>` : ''}</span>
      <span class="scan-metric">${s.prs.total} open PRs${d && d.prs.total ? ` <span class="delta">${sign(d.prs.total)}</span>` : ''}</span>
      <span class="scan-metric">${s.coverage.percent == null ? '—' : s.coverage.percent + '% covered'}</span>
      <span class="scan-metric muted">${s.durationMs != null ? Math.round(s.durationMs / 1000) + 's' : ''}${s.errorCount ? ` · ${s.errorCount} errors` : ''}</span>
    </div>`;
  }).join('');

  return `<div class="section">
    <h3>Scan log</h3>
    <p class="section-hint">Every scan this dashboard has run${meta.since ? `, since ${esc(shortDate(meta.since))}` : ''}.
      ${snapshots.length < 2 ? 'The deltas fill in from the second scan onward.' : ''}</p>
    ${snapshots.length ? `<div class="scan-log">${rows}</div>` : '<div class="muted">No scans recorded yet.</div>'}
  </div>`;
}

// === Findings ============================================================

let findingsSort = sessionStorage.getItem('findingsSort') || 'severity';
let findingsSeverity = sessionStorage.getItem('findingsSeverity') || 'all';
let findingsFix = sessionStorage.getItem('findingsFix') || 'all';
let findingsGroup = sessionStorage.getItem('findingsGroup') || 'flat';
let findingsSearch = '';

async function renderFindings() {
  showLoading('Loading open alerts…');
  let alerts;
  try { alerts = await api('/api/gh/alerts'); } catch (e) { return renderNeedsGitHub(e); }
  window._alerts = alerts;

  const counts = SEVERITY_ORDER.reduce((acc, s) => ({ ...acc, [s]: alerts.filter(a => a.severity === s).length }), {});
  const fixable = alerts.filter(a => a.patchedVersion).length;

  app.innerHTML = `
    ${viewHeader('Findings', `${plural(alerts.length, 'open Dependabot alert')} across every repo`)}
    ${alerts.length ? `<div class="kpi-row">
      ${SEVERITY_ORDER.map(s => `<div class="kpi kpi-filter ${s === 'critical' && counts[s] ? 'kpi-critical' : s === 'high' && counts[s] ? 'kpi-warning' : ''} ${findingsSeverity === s ? 'active' : ''}"
        data-severity="${s}" role="button" tabindex="0" aria-pressed="${findingsSeverity === s}"
        onclick="setFindingsSeverity('${s}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();setFindingsSeverity('${s}')}">
        <div class="kpi-label">${s[0].toUpperCase() + s.slice(1)}</div>
        <div class="kpi-value">${counts[s]}</div>
        <div class="kpi-sub">${counts[s] ? 'click to filter' : 'none open'}</div>
      </div>`).join('')}
      <div class="kpi kpi-ok"><div class="kpi-label">Fix available</div><div class="kpi-value">${fixable}</div>
        <div class="kpi-sub">${alerts.length - fixable} with no patched version</div></div>
    </div>` : ''}

    <div class="patch-controls">
      <div class="repo-filter" role="group" aria-label="Severity filter">
        ${[['all', 'All severities'], ...SEVERITY_ORDER.map(s => [s, s[0].toUpperCase() + s.slice(1)])]
    .map(([k, label]) => `<button class="repo-btn ${findingsSeverity === k ? 'active' : ''}"
      aria-pressed="${findingsSeverity === k}" onclick="setFindingsSeverity('${k}')">${label}
      <span class="filter-count">${k === 'all' ? alerts.length : counts[k]}</span></button>`).join('')}
      </div>
      <div class="patch-controls-row">
        <input class="search-input" id="findings-search" placeholder="Search package, advisory, repo, CVE…"
          value="${esc(findingsSearch)}" aria-label="Search alerts">
        <div class="sort-bar">
          <span class="sort-label">Fix</span>
          ${[['all', 'Any'], ['yes', 'Available'], ['no', 'None yet']].map(([k, label]) =>
    `<button class="sort-btn ${findingsFix === k ? 'active' : ''}" aria-pressed="${findingsFix === k}"
              onclick="setFindingsFix('${k}')">${label}</button>`).join('')}
        </div>
        <div class="sort-bar">
          <span class="sort-label">Sort</span>
          ${[['severity', 'Severity'], ['age', 'Oldest'], ['repo', 'Repo'], ['package', 'Package']].map(([k, label]) =>
    `<button class="sort-btn ${findingsSort === k ? 'active' : ''}" aria-pressed="${findingsSort === k}"
              onclick="setFindingsSort('${k}')">${label}</button>`).join('')}
        </div>
        <div class="sort-bar">
          <span class="sort-label">Group</span>
          ${[['flat', 'None'], ['package', 'By package'], ['repo', 'By repo']].map(([k, label]) =>
    `<button class="sort-btn ${findingsGroup === k ? 'active' : ''}" aria-pressed="${findingsGroup === k}"
              onclick="setFindingsGroup('${k}')">${label}</button>`).join('')}
        </div>
      </div>
    </div>
    <div id="findings-list"></div>`;

  const input = $('findings-search');
  if (input) input.addEventListener('input', debounce(e => { findingsSearch = e.target.value; renderFindingsList(); }, 150));
  renderFindingsList();
}

function setFindingsSeverity(key) {
  findingsSeverity = findingsSeverity === key ? 'all' : key;
  sessionStorage.setItem('findingsSeverity', findingsSeverity);
  syncPressed('.repo-filter .repo-btn', `setFindingsSeverity('${findingsSeverity}')`);
  // The KPI tiles filter too, so they show the same pressed state as the chips.
  document.querySelectorAll('.kpi-filter').forEach(tile => {
    const active = tile.dataset.severity === findingsSeverity;
    tile.classList.toggle('active', active);
    tile.setAttribute('aria-pressed', String(active));
  });
  renderFindingsList();
}
function setFindingsFix(key) {
  findingsFix = key;
  sessionStorage.setItem('findingsFix', key);
  syncPressed('.sort-btn', `setFindingsFix('${key}')`);
  renderFindingsList();
}
function setFindingsSort(key) {
  findingsSort = key;
  sessionStorage.setItem('findingsSort', key);
  syncPressed('.sort-btn', `setFindingsSort('${key}')`);
  renderFindingsList();
}
function setFindingsGroup(key) {
  findingsGroup = key;
  sessionStorage.setItem('findingsGroup', key);
  syncPressed('.sort-btn', `setFindingsGroup('${key}')`);
  renderFindingsList();
}

/** Toggle .active/aria-pressed across a button group without re-rendering the page. */
function syncPressed(selector, activeOnclick) {
  const family = activeOnclick.slice(0, activeOnclick.indexOf('('));
  document.querySelectorAll(selector).forEach(b => {
    const handler = b.getAttribute('onclick') || '';
    if (!handler.startsWith(family)) return;
    const active = handler === activeOnclick;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

function findingsComparator(sort) {
  switch (sort) {
    case 'age': return (a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0);
    case 'repo': return (a, b) => a.repo.localeCompare(b.repo) || severityRank(a.severity) - severityRank(b.severity);
    case 'package': return (a, b) => (a.package || '').localeCompare(b.package || '') || severityRank(a.severity) - severityRank(b.severity);
    default: return (a, b) => severityRank(a.severity) - severityRank(b.severity) || (b.ageDays ?? 0) - (a.ageDays ?? 0);
  }
}

function alertItem(a, { showRepo = true } = {}) {
  return `<a class="alert-item wide" href="${esc(a.url)}" target="_blank" rel="noopener">
    ${severityBadge(a.severity)}
    ${showRepo ? `<span class="alert-repo">${esc(a.repo)}</span>` : ''}
    <span class="alert-pkg">${esc(a.package)}${a.ecosystem ? `<span class="muted"> · ${esc(a.ecosystem)}</span>` : ''}</span>
    <span class="alert-summary">${esc(a.summary)}</span>
    <span class="alert-fix">${a.patchedVersion
    ? `fix: ${esc(a.patchedVersion)}`
    : '<span class="muted" title="No patched version published yet">no fix yet</span>'}</span>
    ${a.ageDays == null ? ''
    : `<span class="alert-age muted" title="Raised ${esc(shortDate(a.createdAt))}">${a.ageDays}d</span>`}
  </a>`;
}

function renderFindingsList() {
  const host = $('findings-list');
  if (!host) return;
  const all = window._alerts || [];
  const q = findingsSearch.trim().toLowerCase();

  let items = all;
  if (findingsSeverity !== 'all') items = items.filter(a => a.severity === findingsSeverity);
  if (findingsFix === 'yes') items = items.filter(a => a.patchedVersion);
  else if (findingsFix === 'no') items = items.filter(a => !a.patchedVersion);
  if (q) {
    items = items.filter(a => [a.package, a.summary, a.repo, a.cveId, a.ghsaId, a.ecosystem, a.manifest]
      .some(f => (f || '').toLowerCase().includes(q)));
  }
  items = [...items].sort(findingsComparator(findingsSort));

  if (!items.length) {
    host.innerHTML = all.length
      ? `<div class="empty"><div class="icon">🔍</div><h3>Nothing matches</h3>
         <p>No alerts match the current filters${q ? ` and “${esc(findingsSearch)}”` : ''}.</p>
         <button class="refresh-btn" onclick="clearFindingsFilters()" style="margin-top:14px">Clear filters</button></div>`
      : `<div class="empty"><div class="icon">🎉</div><h3>No open alerts</h3>
         <p>Every repo this token can see is free of open Dependabot alerts.</p></div>`;
    return;
  }

  const footnote = `<div class="table-footnote">${items.length} of ${all.length} alerts</div>`;

  if (findingsGroup === 'flat') {
    host.innerHTML = `<div class="alert-list">${items.map(a => alertItem(a)).join('')}</div>${footnote}`;
    return;
  }

  const key = findingsGroup === 'package' ? (a => a.package || 'unknown') : (a => a.repo);
  const groups = new Map();
  for (const a of items) {
    const k = key(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  host.innerHTML = ordered.map(([name, list]) => {
    const worst = list.reduce((w, a) => Math.min(w, severityRank(a.severity)), 4);
    const repos = new Set(list.map(a => a.repo)).size;
    return `<div class="finding-group">
      <div class="finding-group-head">
        <span class="badge badge-${SEVERITY_ORDER[worst] || 'info'}">${list.length}</span>
        <span class="finding-group-name">${esc(name)}</span>
        <span class="muted">${findingsGroup === 'package' ? plural(repos, 'repo') : plural(list.length, 'alert')}</span>
      </div>
      <div class="alert-list">${list.map(a => alertItem(a, { showRepo: findingsGroup !== 'repo' })).join('')}</div>
    </div>`;
  }).join('') + footnote;
}

function clearFindingsFilters() {
  findingsSeverity = 'all';
  findingsFix = 'all';
  findingsSearch = '';
  sessionStorage.setItem('findingsSeverity', 'all');
  sessionStorage.setItem('findingsFix', 'all');
  const input = $('findings-search');
  if (input) input.value = '';
  syncPressed('.repo-filter .repo-btn', 'setFindingsSeverity(\'all\')');
  syncPressed('.sort-btn', 'setFindingsFix(\'all\')');
  document.querySelectorAll('.kpi-filter').forEach(tile => {
    tile.classList.remove('active');
    tile.setAttribute('aria-pressed', 'false');
  });
  renderFindingsList();
}

// === Calendar ============================================================

const CAL_MODES = {
  raised: { label: 'Alerts raised', field: 'raised', tone: 'red', unit: 'alert' },
  merges: { label: 'Dependency PRs merged', field: 'merges', tone: 'green', unit: 'merge' },
  prsOpened: { label: 'PRs opened', field: 'prsOpened', tone: 'purple', unit: 'PR' }
};
let calMode = sessionStorage.getItem('calMode') || 'merges';
let calSelected = null;

async function renderCalendar() {
  showLoading('Building calendar…');
  let cal;
  try { cal = await api('/api/gh/calendar?days=91'); } catch (e) { return renderNeedsGitHub(e); }
  window._calendar = cal;
  calSelected = null;

  const totals = Object.fromEntries(Object.entries(CAL_MODES)
    .map(([k, m]) => [k, cal.cells.reduce((sum, c) => sum + c[m.field], 0)]));

  app.innerHTML = `
    ${viewHeader('Calendar', `Last 13 weeks of activity · scanned ${esc(relTime(cal.dataAsOf))}`)}
    <div class="repo-filter" role="group" aria-label="Calendar mode">
      ${Object.entries(CAL_MODES).map(([k, m]) => `<button class="repo-btn ${calMode === k ? 'active' : ''}"
        aria-pressed="${calMode === k}" onclick="setCalMode('${k}')">${m.label}
        <span class="filter-count">${totals[k]}</span></button>`).join('')}
    </div>
    ${noteBanner('Built from the dates on currently-open alerts and PRs, plus merged pull requests. Alerts that were already fixed leave no trace on GitHub, so they cannot appear.')}
    ${mergeCoverageNote(cal.mergeCoverage)}
    <div id="calendar-host"></div>
    <div id="calendar-detail"></div>`;

  drawCalendar();
}

function setCalMode(mode) {
  calMode = mode;
  sessionStorage.setItem('calMode', mode);
  calSelected = null;
  document.querySelectorAll('.repo-filter .repo-btn').forEach(b => {
    const active = b.getAttribute('onclick') === `setCalMode('${mode}')`;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  drawCalendar();
  const detail = $('calendar-detail');
  if (detail) detail.innerHTML = '';
}

/** Bucket days into GitHub-style columns: one column per week, Sunday at the top. */
function calendarWeeks(cells) {
  const weeks = [];
  let current = new Array(7).fill(null);
  let started = false;
  for (const cell of cells) {
    const dow = new Date(cell.date + 'T00:00:00Z').getUTCDay();
    if (started && dow === 0) { weeks.push(current); current = new Array(7).fill(null); }
    current[dow] = cell;
    started = true;
  }
  weeks.push(current);
  return weeks;
}

function calLevel(value, max) {
  if (!value) return 0;
  if (max <= 1) return 4;
  return Math.min(4, Math.ceil((value / max) * 4));
}

function drawCalendar() {
  const host = $('calendar-host');
  const cal = window._calendar;
  if (!host || !cal) return;

  const mode = CAL_MODES[calMode];
  const weeks = calendarWeeks(cal.cells);
  const max = cal.cells.reduce((m, c) => Math.max(m, c[mode.field]), 0);

  if (!max) {
    host.innerHTML = `<div class="empty compact"><div class="icon">📭</div>
      <h3>No ${esc(mode.label.toLowerCase())} in this window</h3>
      <p>Nothing to plot for the last 13 weeks. The other modes above may still have activity.</p></div>`;
    return;
  }
  const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let lastMonth = -1;
  const monthRow = weeks.map(week => {
    const first = week.find(Boolean);
    if (!first) return '<span class="cal-month-label"></span>';
    const month = new Date(first.date + 'T00:00:00Z').getUTCMonth();
    if (month === lastMonth) return '<span class="cal-month-label"></span>';
    lastMonth = month;
    return `<span class="cal-month-label">${monthNames[month]}</span>`;
  }).join('');

  // Roving tabindex: the grid is one tab stop, arrows move inside it. 91
  // separate tab stops is not navigation, it is an obstacle.
  const focusDate = calSelected || cal.cells[cal.cells.length - 1]?.date;
  const columns = weeks.map(week => `<div class="cal-week">${week.map(cell => {
    if (!cell) return '<span class="cal-day cal-empty" aria-hidden="true"></span>';
    const value = cell[mode.field];
    const level = calLevel(value, max);
    const selected = calSelected === cell.date ? ' selected' : '';
    const label = `${shortDate(cell.date)}: ${plural(value, mode.unit)}`;
    return `<button class="cal-day cal-${mode.tone} cal-l${level}${selected}" data-date="${cell.date}"
      tabindex="${cell.date === focusDate ? '0' : '-1'}"
      title="${esc(label)}" aria-label="${esc(label)}" onclick="selectCalDay('${jsAttr(cell.date)}')"></button>`;
  }).join('')}</div>`).join('');

  host.innerHTML = `<div class="calendar-heatmap">
    <div class="cal-grid">
      <div class="cal-months">${monthRow}</div>
      <div class="cal-body">
        <div class="cal-daylabels">${dayLabels.map(l => `<span class="cal-label">${l}</span>`).join('')}</div>
        <div class="cal-weeks">${columns}</div>
      </div>
    </div>
    <div class="cal-legend">
      <span class="muted">Less</span>
      ${[0, 1, 2, 3, 4].map(l => `<span class="cal-day cal-${mode.tone} cal-l${l}" aria-hidden="true"></span>`).join('')}
      <span class="muted">More</span>
      <span class="cal-legend-max muted">Busiest day: ${plural(max, mode.unit)}</span>
    </div>
  </div>`;

  bindCalendarKeys(host);
}

/**
 * Columns are weeks and rows are weekdays, so left/right steps a week and
 * up/down steps a day — matching what the eye sees, not the array order.
 */
function bindCalendarKeys(host) {
  const grid = host.querySelector('.cal-weeks');
  if (!grid) return;
  grid.addEventListener('keydown', e => {
    const steps = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    const cells = [...grid.querySelectorAll('.cal-day[data-date]')];
    const from = cells.indexOf(document.activeElement);
    if (from === -1) return;

    let to;
    if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = cells.length - 1;
    else if (steps[e.key] != null) to = from + steps[e.key];
    else return;

    e.preventDefault();
    const target = cells[Math.max(0, Math.min(cells.length - 1, to))];
    if (!target) return;
    cells.forEach(c => c.setAttribute('tabindex', '-1'));
    target.setAttribute('tabindex', '0');
    target.focus();
  });
}

function selectCalDay(date) {
  const cal = window._calendar;
  const cell = cal?.cells.find(c => c.date === date);
  const detail = $('calendar-detail');
  if (!cell || !detail) return;

  calSelected = calSelected === date ? null : date;
  document.querySelectorAll('.cal-day[data-date]').forEach(el =>
    el.classList.toggle('selected', el.dataset.date === calSelected));

  if (!calSelected) { detail.innerHTML = ''; return; }

  const blocks = [];
  if (cell.mergeList.length) {
    // The list is every merge, so the heading says so — the cell's own label
    // counts dependency PRs only, and one number must not shadow the other.
    const mergedTotal = cell.merges + cell.otherMerges;
    const split = cell.otherMerges
      ? ` <span class="muted">— ${cell.merges} dependency, ${cell.otherMerges} other</span>` : '';
    blocks.push(`<div class="detail-block"><h4>All merges (${mergedTotal})${split}</h4>
      <div class="pr-list wide">${cell.mergeList.map(m => `
        <a class="pr-item" href="${esc(m.url)}" target="_blank" rel="noopener">
          <span class="pr-num">#${m.number}</span><span class="pr-repo">${esc(m.repo)}</span>
          <span class="pr-title">${esc(m.title)}</span></a>`).join('')}</div>
      ${truncNote(cell.mergeList.length, mergedTotal)}</div>`);
  }
  if (cell.alerts.length) {
    blocks.push(`<div class="detail-block"><h4>Alerts raised (${cell.raised})</h4>
      <div class="alert-list">${cell.alerts.map(a => alertItem({ ...a, ageDays: null })).join('')}</div>
      ${truncNote(cell.alerts.length, cell.raised)}</div>`);
  }
  if (cell.prs.length) {
    blocks.push(`<div class="detail-block"><h4>Pull requests opened (${cell.prsOpened})</h4>
      <div class="pr-list wide">${cell.prs.map(p => `
        <a class="pr-item" href="${esc(p.url)}" target="_blank" rel="noopener">
          <span class="pr-num">#${p.number}</span><span class="pr-repo">${esc(p.repo)}</span>
          <span class="pr-title">${esc(p.title)}</span></a>`).join('')}</div>
      ${truncNote(cell.prs.length, cell.prsOpened)}</div>`);
  }

  detail.innerHTML = `<div class="section cal-detail">
    <h3>${esc(shortDate(date))}
      <button class="mini-link" onclick="selectCalDay('${jsAttr(date)}')" aria-label="Close day detail">close ✕</button></h3>
    ${blocks.length ? blocks.join('') : '<div class="muted">Nothing recorded on this day.</div>'}
  </div>`;
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// === Shared ==============================================================

/** The API caps each day's detail list; never let a short list imply a small day. */
function truncNote(shown, total) {
  return shown < total ? `<div class="muted">+${total - shown} more not shown</div>` : '';
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/** 503 from the GitHub routes means no token — send people to Settings, not an error. */
function renderNeedsGitHub(error) {
  if (/not configured/i.test(error.message)) {
    app.innerHTML = renderSetupScreen();
    return;
  }
  showError('Could not load GitHub data', error.message);
}
