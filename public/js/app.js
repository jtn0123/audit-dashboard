const $ = id => document.getElementById(id);
const app = $('app');
let charts = [];

const AGENTS = {
  security:     { icon: '🔒', label: 'Security' },
  quality:      { icon: '📊', label: 'Quality' },
  infra:        { icon: '🏗️', label: 'Infrastructure' },
  dependencies: { icon: '📦', label: 'Dependencies' },
  lighthouse:   { icon: '⚡', label: 'Lighthouse' },
  consistency:  { icon: '🔄', label: 'Consistency' },
  roadmap:      { icon: '🗺️', label: 'Roadmap' },
  digest:       { icon: '📋', label: 'Digest' }
};

const AGENT_ORDER = ['security', 'quality', 'infra', 'dependencies', 'lighthouse', 'consistency', 'roadmap'];

function navigate(path) { window.location.hash = path; }
function getRoute() { return window.location.hash.slice(1) || '/'; }
async function api(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`API error: ${r.status} ${r.statusText}`);
  return r.json();
}

function showError(message, detail) {
  app.innerHTML = `<div class="empty"><div class="icon">⚠️</div><h3>${message}</h3><p style="color:var(--text-muted);max-width:500px">${detail || 'Try refreshing the page.'}</p><button class="refresh-btn" onclick="route()" style="margin-top:16px">↻ Retry</button></div>`;
}

function renderCardError(agent, error) {
  const a = AGENTS[agent] || { icon: '📄', label: agent };
  return `<div class="card card-critical" style="cursor:default">
    <div class="card-header"><span class="agent-label">${a.icon} ${a.label}</span><span class="status-dot red"></span></div>
    <div class="card-body"><span class="card-grade" style="color:var(--red)">ERR</span></div>
    <div class="card-summary" style="color:var(--red)">Failed to load</div>
  </div>`;
}

window.addEventListener('unhandledrejection', (e) => {
  console.warn('Unhandled rejection:', e.reason);
  showError('Something went wrong', e.reason?.message || String(e.reason));
});
function destroyCharts() { charts.forEach(c => c.destroy()); charts = []; }

function statusClass(status) {
  return status === 'ok' ? 'ok' : status === 'warning' ? 'warning' : 'critical';
}

function statusDotClass(status) {
  return status === 'ok' ? 'green' : status === 'warning' ? 'yellow' : 'red';
}

function gradeClass(grade) {
  if (!grade) return '';
  const g = grade.charAt(0).toUpperCase();
  if (g === 'A') return 'grade-a';
  if (g === 'B') return 'grade-b';
  if (g === 'C') return 'grade-c';
  return 'grade-d';
}

function scoreColor(score) {
  if (score >= 80) return 'var(--green)';
  if (score >= 50) return 'var(--yellow)';
  return 'var(--red)';
}

function formatDuration(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60), s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function severityBadge(sev) {
  const s = (sev || 'info').toLowerCase();
  return `<span class="badge badge-${s}">${sev || 'info'}</span>`;
}

function severityRank(s) {
  const map = { critical: 0, CRITICAL: 0, high: 1, HIGH: 1, medium: 2, MEDIUM: 2, low: 3, LOW: 3, info: 4, INFO: 4 };
  return map[s] ?? 5;
}

// Skeleton loaders
function skeletonDashboard() {
  return `<div class="health-hero">
    <div class="skeleton skeleton-circle" style="width:160px;height:160px"></div>
    <div class="skeleton skeleton-text w40" style="margin-top:12px;width:120px"></div>
  </div>
  <div class="skeleton skeleton-text w60" style="height:20px;margin-bottom:16px;width:180px"></div>
  <div class="cards">
    ${Array(7).fill('<div class="skeleton" style="height:120px"></div>').join('')}
  </div>
  <div style="margin-top:32px">
    ${Array(3).fill('<div class="skeleton skeleton-text w80" style="height:48px;margin-bottom:8px"></div>').join('')}
  </div>`;
}

function skeletonGeneric(n = 4) {
  return `<div class="skeleton skeleton-text w60" style="height:24px;margin-bottom:20px;width:200px"></div>
  ${Array(n).fill('<div class="skeleton" style="height:80px;margin-bottom:8px"></div>').join('')}`;
}

function showSkeleton(type) {
  app.innerHTML = type === 'dashboard' ? skeletonDashboard() : skeletonGeneric();
}

// Health score hero
function calcHealthScore(reports) {
  const scores = reports.filter(r => r.agent !== 'meta' && r.agent !== 'digest' && r.score != null).map(r => r.score);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function renderHealthHero(score, date, delta) {
  if (score == null) return '';
  const color = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--yellow)' : 'var(--red)';
  const r = 70, c = 2 * Math.PI * r;
  const offset = c * (1 - score / 100);
  let deltaHtml = '';
  if (delta != null && delta !== 0) {
    const cls = delta > 0 ? 'up' : 'down';
    const arrow = delta > 0 ? '↑' : '↓';
    deltaHtml = `<div class="health-delta ${cls}">${arrow}${Math.abs(delta)} from yesterday</div>`;
  } else if (delta === 0) {
    deltaHtml = '<div class="health-delta flat">No change from yesterday</div>';
  }
  return `<div class="health-hero anim-fade-in">
    <div class="health-gauge">
      <svg viewBox="0 0 160 160">
        <circle class="gauge-bg" cx="80" cy="80" r="${r}"/>
        <circle class="gauge-fg" cx="80" cy="80" r="${r}" stroke="${color}"
          stroke-dasharray="${c}" stroke-dashoffset="${offset}"/>
      </svg>
      <div class="health-gauge-label">
        <div class="health-gauge-score" style="color:${color}">${score}</div>
        <div class="health-gauge-sub">Overall Health</div>
      </div>
    </div>
    <div style="color:var(--text-dim);font-size:.82rem;margin-top:6px">${date}</div>
    ${deltaHtml}
  </div>`;
}

// Animate cards after insert
function animateCards() {
  document.querySelectorAll('.card').forEach((card, i) => {
    card.classList.add('anim-card');
    card.style.animationDelay = `${i * 50}ms`;
  });
}

// Router
async function route() {
  destroyCharts();
  const path = getRoute();
  document.querySelectorAll('nav a[id]').forEach(a => a.classList.remove('active'));

  if (path === '/') {
    $('nav-dash')?.classList.add('active');
    await renderDashboard();
  } else if (path === '/trends') {
    $('nav-trends')?.classList.add('active');
    await renderTrends();
  } else if (path === '/history') {
    $('nav-history')?.classList.add('active');
    await renderHistory();
  } else if (path.startsWith('/report/')) {
    const parts = path.split('/').filter(Boolean);
    await renderReport(parts[1], parts[2]);
  } else {
    await renderDashboard();
  }
}

// Dashboard
async function renderDashboard() {
  showSkeleton('dashboard');
  let dates;
  try { dates = await api('/api/dates'); } catch (e) { showError('Failed to load audit data', e.message); return; }
  if (!dates.length) {
    app.innerHTML = '<div class="empty"><div class="icon">📋</div><h3>No audit data yet</h3><p>Run a nightly audit to see results here.</p></div>';
    return;
  }

  const today = dates[0];
  let reports;
  try { reports = await api(`/api/report/${today}`); } catch (e) { showError('Failed to load reports', e.message); return; }

  // Calculate health score and delta
  const todayScore = calcHealthScore(reports);
  let delta = null;
  if (dates.length > 1) {
    try {
      const yesterdayReports = await api(`/api/report/${dates[1]}`);
      const yesterdayScore = calcHealthScore(yesterdayReports);
      if (todayScore != null && yesterdayScore != null) delta = todayScore - yesterdayScore;
    } catch {}
  }

  // Update header meta
  const meta = reports.find(r => r.agent === 'meta');
  if (meta) {
    const raw = meta.raw || {};
    const end = raw.endTime ? new Date(raw.endTime) : null;
    const el = $('header-meta');
    if (el) {
      let t = '';
      if (end) t += end.toLocaleString();
      if (raw.durationSeconds) t += ` (${formatDuration(raw.durationSeconds)})`;
      el.textContent = t;
    }
  }

  const byAgent = {};
  reports.forEach(r => { byAgent[r.agent] = r; });

  let html = '';

  // Header
  html += `<div class="dash-header">
    <div><h1>Nightly Audit</h1><div class="date-info">${today}${meta?.raw?.durationSeconds ? ' · ' + formatDuration(meta.raw.durationSeconds) : ''}</div></div>
    <button class="refresh-btn" onclick="route()">↻ Refresh</button>
  </div>`;

  // Health Score Hero
  html += renderHealthHero(todayScore, today, delta);

  // Digest / Portfolio Health
  const digest = byAgent.digest;
  if (digest) {
    const hs = digest.healthScores || {};
    html += '<div class="section digest-section" style="margin-bottom:24px">';
    html += '<h2>Portfolio Health</h2>';
    html += '<div class="cards" style="margin-bottom:12px">';
    for (const [repo, score] of Object.entries(hs).sort((a, b) => b[1] - a[1])) {
      const sc = score >= 80 ? 'ok' : score >= 50 ? 'warning' : 'critical';
      html += `<div class="card card-${sc}" style="cursor:default">
        <div class="card-header"><span class="agent-label">${repo}</span><span class="status-dot ${statusDotClass(sc)}"></span></div>
        <div class="card-body"><span class="card-grade ${gradeClass(null)}" style="color:${scoreColor(score)}">${score}</span><span class="card-score">/100</span></div>
      </div>`;
    }
    html += '</div>';
    const prio = digest.topPriorities || [];
    if (prio.length) {
      html += '<div style="padding:0 4px"><strong style="font-size:.9rem;color:var(--text-dim)">Top Priorities</strong><ul style="padding-left:20px;margin-top:8px">';
      prio.forEach(p => { html += `<li style="font-size:.88rem;margin-bottom:4px;color:var(--yellow)">${p}</li>`; });
      html += '</ul></div>';
    }
    html += '</div>';
  }

  // Agent cards
  html += '<div class="section"><h2>Agent Reports</h2></div>';
  html += '<div class="cards">';
  for (const agent of AGENT_ORDER) {
    const r = byAgent[agent];
    if (!r) { html += renderCardError(agent, 'No data'); continue; }
    const a = AGENTS[agent];
    const sc = statusClass(r.status);
    const display = r.grade || (r.score != null ? r.score : '—');
    const gc = r.grade ? gradeClass(r.grade) : '';

    html += `<div class="card card-${sc}" onclick="navigate('/report/${today}/${agent}')">
      <div class="card-header">
        <span class="agent-label">${a.icon} ${a.label}</span>
        <span class="status-dot ${statusDotClass(r.status)}"></span>
      </div>
      <div class="card-body">
        <span class="card-grade ${gc}" style="${!r.grade ? 'color:' + scoreColor(r.score || 0) : ''}">${display}</span>
        ${r.grade && r.score != null ? `<span class="card-score">${r.score}/100</span>` : ''}
      </div>
      <div class="card-summary">${r.summary || ''}</div>
    </div>`;
  }
  html += '</div>';

  // Security findings
  const sec = byAgent.security;
  if (sec?.findings?.length) {
    const findings = [...sec.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    html += `<div class="section"><h2>🔒 Security Findings <span class="count">${findings.length}</span></h2>`;
    findings.forEach(f => { html += renderFinding(f); });
    html += '</div>';
  }

  // Roadmap priorities
  const road = byAgent.roadmap;
  if (road?.priorities?.length) {
    html += `<div class="section"><h2>🗺️ Top Priorities <span class="count">${Math.min(5, road.priorities.length)}</span></h2>`;
    road.priorities.slice(0, 5).forEach(p => {
      html += renderFinding({
        severity: p.severity, id: `#${p.rank}`, title: p.title,
        description: p.description, repo: p.repo,
        recommendation: `Effort: ${p.effort} · Impact: ${p.impact}`
      });
    });
    html += '</div>';
  }

  // Infra alerts
  const infra = byAgent.infra;
  if (infra?.alerts?.length) {
    html += `<div class="section"><h2>🏗️ Infrastructure Alerts <span class="count">${infra.alerts.length}</span></h2>`;
    infra.alerts.forEach(a => {
      html += renderFinding({ severity: a.severity, title: a.message });
    });
    html += '</div>';
  }

  app.innerHTML = html;
  animateCards();
  bindFindingToggles();
}

function renderFinding(f) {
  const sev = (f.severity || 'info').toLowerCase();
  return `<div class="finding">
    <div class="finding-header">
      <span class="expand-icon">▶</span>
      ${severityBadge(f.severity)}
      ${f.id ? `<span class="finding-id">${f.id}</span>` : ''}
      <span class="finding-title">${f.title || ''}</span>
    </div>
    <div class="finding-details">
      ${f.repo || f.file ? `<div class="finding-meta">${f.repo || ''}${f.file ? ' · <code>' + f.file + (f.line ? ':' + f.line : '') + '</code>' : ''}</div>` : ''}
      ${f.description ? `<div class="finding-desc">${f.description}</div>` : ''}
      ${f.recommendation ? `<div class="finding-rec">💡 ${f.recommendation}</div>` : ''}
      ${f.cwe ? `<div class="finding-cwe">${f.cwe}</div>` : ''}
    </div>
  </div>`;
}

function bindFindingToggles() {
  document.querySelectorAll('.finding-header').forEach(h => {
    h.addEventListener('click', () => {
      h.parentElement.classList.toggle('expanded');
    });
  });
}

// Report Detail
async function renderReport(date, agent) {
  showSkeleton('generic');

  if (!agent) {
    let reports;
    try { reports = await api(`/api/report/${date}`); } catch (e) { showError('Failed to load reports', e.message); return; }
    let html = `<div class="dash-header"><div><a class="back-link" href="#/" onclick="navigate('/');return false">← Dashboard</a><h1>Reports for ${date}</h1></div></div>`;
    html += '<div class="cards">';
    for (const r of reports) {
      if (r.agent === 'meta') continue;
      const a = AGENTS[r.agent] || { icon: '📄', label: r.agent };
      const sc = statusClass(r.status);
      html += `<div class="card card-${sc}" onclick="navigate('/report/${date}/${r.agent}')">
        <div class="card-header"><span class="agent-label">${a.icon} ${a.label}</span><span class="status-dot ${statusDotClass(r.status)}"></span></div>
        <div class="card-body"><span class="card-grade" style="color:${scoreColor(r.score||0)}">${r.grade || (r.score != null ? r.score : '—')}</span></div>
      </div>`;
    }
    html += '</div>';
    app.innerHTML = html;
    return;
  }

  // Try markdown first
  try {
    const mdRes = await fetch(`/api/report/${date}/${agent}/md`);
    if (mdRes.ok) {
      const md = await mdRes.text();
      const a = AGENTS[agent] || { icon: '📄', label: agent };
      app.innerHTML = `<div class="dash-header"><div><a class="back-link" href="#/" onclick="navigate('/');return false">← Dashboard</a><h1>${a.icon} ${a.label} Report</h1><div class="date-info">${date}</div></div></div>
        <div class="markdown-body">${marked.parse(md)}</div>`;
      return;
    }
  } catch {}

  // Fallback JSON
  let report;
  try { report = await api(`/api/report/${date}/${agent}`); } catch (e) { showError('Failed to load report', e.message); return; }
  if (report.error) { app.innerHTML = '<div class="empty"><div class="icon">🔍</div><h3>Report not found</h3></div>'; return; }
  const a = AGENTS[agent] || { icon: '📄', label: agent };
  app.innerHTML = `<div class="dash-header"><div><a class="back-link" href="#/" onclick="navigate('/');return false">← Dashboard</a><h1>${a.icon} ${a.label} Report</h1><div class="date-info">${date} · Score: ${report.score ?? '—'}</div></div></div>
    <div class="markdown-body"><pre><code>${JSON.stringify(report.raw, null, 2)}</code></pre></div>`;
}

// Trends
async function renderTrends() {
  showSkeleton('generic');
  let trends;
  try { trends = await api('/api/trends'); } catch (e) { showError('Failed to load trends', e.message); return; }

  let html = '<div class="dash-header"><h1>Trends</h1></div>';
  html += '<div class="chart-grid"><div class="chart-box"><h3>Agent Scores Over Time</h3><canvas id="scoreChart"></canvas></div></div>';
  app.innerHTML = html;

  const colors = {
    security: '#f85149', quality: '#3fb950', infra: '#58a6ff',
    dependencies: '#d29922', lighthouse: '#bc8cff', consistency: '#79c0ff', roadmap: '#d2a8ff'
  };

  const opts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#8b949e', usePointStyle: true, padding: 16 } } },
    scales: {
      x: { ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,.4)' } },
      y: { ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,.4)' }, min: 0, max: 100 }
    }
  };

  const datasets = Object.entries(trends.data || {})
    .filter(([n]) => n !== 'digest')
    .map(([name, data]) => ({
      label: AGENTS[name]?.label || name,
      data: data.map(d => ({ x: d.date, y: d.score })),
      borderColor: colors[name] || '#8b949e',
      backgroundColor: (colors[name] || '#8b949e') + '22',
      tension: .3, fill: false, pointRadius: 5,
      pointBackgroundColor: colors[name] || '#8b949e'
    }));

  charts.push(new Chart($('scoreChart'), { type: 'line', data: { datasets }, options: opts }));
  app.classList.add('anim-fade-in');
  app.addEventListener('animationend', () => app.classList.remove('anim-fade-in'), { once: true });
}

// History
async function renderHistory() {
  showSkeleton('generic');
  let dates;
  try { dates = await api('/api/dates'); } catch (e) { showError('Failed to load history', e.message); return; }

  let html = '<div class="dash-header"><h1>Audit History</h1></div>';
  html += '<div class="history-list">';

  for (const date of dates) {
    let reports;
    try { reports = await api(`/api/report/${date}`); } catch { continue; }
    const meta = reports.find(r => r.agent === 'meta');
    const agentReports = reports.filter(r => r.agent !== 'meta' && r.agent !== 'digest');
    const dur = meta?.raw?.durationSeconds;
    const worst = agentReports.reduce((w, r) => {
      if (r.status === 'critical') return 'critical';
      if (r.status === 'warning' && w !== 'critical') return 'warning';
      return w;
    }, 'ok');

    html += `<div class="history-row ${worst}" onclick="navigate('/report/${date}')">
      <span class="history-date">${date}</span>
      <div class="history-agents">
        ${agentReports.map(r => `<span class="agent-chip ${statusClass(r.status)}">${(AGENTS[r.agent]?.icon || '')} ${r.score ?? '—'}</span>`).join('')}
      </div>
      ${dur ? `<span class="history-duration">${formatDuration(dur)}</span>` : ''}
    </div>`;
  }

  html += '</div>';
  app.innerHTML = html;
  app.classList.add('anim-fade-in');
  app.addEventListener('animationend', () => app.classList.remove('anim-fade-in'), { once: true });
}

// Init
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
