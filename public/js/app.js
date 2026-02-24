const $ = id => document.getElementById(id);
const app = $('app');
let charts = [];
let repoFilter = sessionStorage.getItem('repoFilter') || 'all';
let autoRefreshTimer = null;
let lastRefreshTime = null;

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

// #11: Breadcrumb navigation
function renderBreadcrumbs(segments) {
  // segments: [{label, hash}]
  return `<div class="breadcrumbs">${segments.map((s, i) =>
    i < segments.length - 1
      ? `<a href="#${s.hash}" onclick="navigate('${s.hash}');return false">${s.label}</a><span class="bc-sep">›</span>`
      : `<span class="bc-current">${s.label}</span>`
  ).join('')}</div>`;
}

// #6: Severity summary bar
function renderSeverityBar(counts) {
  const total = (counts.critical||0) + (counts.high||0) + (counts.medium||0) + (counts.low||0);
  if (!total) return '';
  const pct = (n) => ((n / total) * 100).toFixed(1);
  return `<div class="severity-bar" title="Critical: ${counts.critical||0} · High: ${counts.high||0} · Medium: ${counts.medium||0} · Low: ${counts.low||0}">
    ${counts.critical ? `<div class="sev-seg sev-critical" style="width:${pct(counts.critical)}%"></div>` : ''}
    ${counts.high ? `<div class="sev-seg sev-high" style="width:${pct(counts.high)}%"></div>` : ''}
    ${counts.medium ? `<div class="sev-seg sev-medium" style="width:${pct(counts.medium)}%"></div>` : ''}
    ${counts.low ? `<div class="sev-seg sev-low" style="width:${pct(counts.low)}%"></div>` : ''}
  </div>`;
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

function animateCards() {
  document.querySelectorAll('.card').forEach((card, i) => {
    card.classList.add('anim-card');
    card.style.animationDelay = `${i * 50}ms`;
  });
}

// #12: Auto-refresh
function startAutoRefresh() {
  stopAutoRefresh();
  lastRefreshTime = Date.now();
  updateRefreshIndicator();
  autoRefreshTimer = setInterval(() => {
    lastRefreshTime = Date.now();
    route();
  }, 60000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

function updateRefreshIndicator() {
  const el = $('refresh-indicator');
  if (el) el.textContent = 'Updated just now';
}

// Router
async function route() {
  destroyCharts();
  stopAutoRefresh();
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
  } else if (path === '/findings') {
    $('nav-findings')?.classList.add('active');
    await renderFindings();
  } else if (path === '/calendar') {
    $('nav-calendar')?.classList.add('active');
    await renderCalendar();
  } else if (path.startsWith('/diff')) {
    await renderDiff(path.split('/')[2]);
  } else if (path.startsWith('/report/')) {
    const parts = path.split('/').filter(Boolean);
    await renderReport(parts[1], parts[2]);
  } else {
    await renderDashboard();
  }
  startAutoRefresh();
}

// Dashboard
async function renderDashboard() {
  showSkeleton('dashboard');
  let summary;
  try { summary = await api('/api/summary'); } catch (e) { showError('Failed to load audit data', e.message); return; }
  if (summary.error) {
    app.innerHTML = '<div class="empty"><div class="icon">📋</div><h3>No audit data yet</h3><p>Run a nightly audit to see results here.</p></div>';
    return;
  }

  const today = summary.date;
  let reports, trends;
  try { reports = await api(`/api/report/${today}`); } catch (e) { showError('Failed to load reports', e.message); return; }
  try { trends = await api('/api/trends'); } catch { trends = null; }

  const todayScore = summary.healthScore;
  const delta = summary.delta;

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

  // #12: Last updated display
  const lastRunDisplay = summary.lastRunTime ? new Date(summary.lastRunTime).toUTCString().replace('GMT', 'UTC') : '';
  const lastUpdatedEl = $('last-updated');
  if (lastUpdatedEl && lastRunDisplay) {
    lastUpdatedEl.textContent = `Last audit: ${lastRunDisplay}`;
    lastUpdatedEl.style.display = 'inline';
  }

  const byAgent = {};
  reports.forEach(r => { byAgent[r.agent] = r; });

  let html = '';

  // Header
  html += `<div class="dash-header">
    <div><h1>Nightly Audit</h1><div class="date-info">${today}${summary.lastRunDuration ? ' · ' + formatDuration(summary.lastRunDuration) : ''}</div></div>
    <div style="display:flex;gap:8px;align-items:center">
      <span id="refresh-indicator" style="color:var(--text-muted);font-size:.75rem"></span>
      <button class="refresh-btn diff-btn" onclick="navigate('/diff/${today}')">🔀 What Changed</button>
      <button class="refresh-btn" onclick="route()">↻ Refresh</button>
    </div>
  </div>`;

  // Repo filter
  html += renderRepoFilter();

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
      ${r.score != null ? `<div class="score-bar"><div class="score-bar-fill" data-score="${r.score}" style="background:${scoreColor(r.score)}"></div></div>` : ''}
      <canvas class="sparkline-canvas" data-agent="${agent}" width="120" height="32"></canvas>
    </div>`;
  }
  html += '</div>';

  // #6: Security findings - top 5 + severity bar
  const sec = byAgent.security;
  if (sec?.findings?.length) {
    const findings = [...sec.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const counts = sec.findingCounts || {};
    html += `<div class="section"><h2>🔒 Security Findings <span class="count">${findings.length}</span></h2>`;
    html += renderSeverityBar(counts);
    findings.slice(0, 5).forEach(f => { html += renderFinding(f); });
    if (findings.length > 5) {
      html += `<a href="#/findings" onclick="navigate('/findings');return false" class="view-all-link">View all ${findings.length} findings →</a>`;
    }
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
  updateRefreshIndicator();

  // Animate score bars
  requestAnimationFrame(() => {
    document.querySelectorAll('.score-bar-fill[data-score]').forEach(el => {
      el.style.width = el.dataset.score + '%';
    });
  });

  // #8: Draw sparklines (120×32) with tooltips
  if (trends?.data) {
    document.querySelectorAll('.sparkline-canvas[data-agent]').forEach(canvas => {
      const agentData = trends.data[canvas.dataset.agent];
      if (!agentData || agentData.length < 2) { canvas.style.display = 'none'; return; }
      const recent = agentData.slice(-7);
      const scores = recent.map(d => d.score);
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const min = Math.min(...scores), max = Math.max(...scores);
      const range = max - min || 1;
      const pad = 2;

      const first = scores[0], last = scores[scores.length - 1];
      const resolved = getComputedStyle(document.documentElement).getPropertyValue(
        last < 50 ? '--red' : last < first - 5 ? '--yellow' : '--green'
      ).trim();

      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = resolved;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      const points = [];
      scores.forEach((s, i) => {
        const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
        const y = h - pad - ((s - min) / range) * (h - pad * 2);
        points.push({ x, y, date: recent[i].date, score: s });
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Tooltip on hover
      const tooltip = document.createElement('div');
      tooltip.className = 'sparkline-tooltip';
      tooltip.style.display = 'none';
      canvas.parentElement.style.position = 'relative';
      canvas.parentElement.appendChild(tooltip);

      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        let closest = points[0], closestDist = Infinity;
        for (const p of points) {
          const d = Math.abs(p.x - mx);
          if (d < closestDist) { closestDist = d; closest = p; }
        }
        tooltip.textContent = `${closest.date}: ${closest.score}`;
        tooltip.style.display = 'block';
        tooltip.style.left = `${closest.x}px`;
        tooltip.style.top = `${canvas.offsetTop - 20}px`;
      });
      canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    });
  }
}

function renderFinding(f) {
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
    let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: date, hash: `/report/${date}`}]);
    html += `<div class="dash-header"><div><h1>Reports for ${date}</h1></div></div>`;
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

  const a = AGENTS[agent] || { icon: '📄', label: agent };

  // #7: Per-agent trend chart - fetch trend data
  let trendHtml = '';
  try {
    const trends = await api(`/api/trends?agent=${agent}&days=14`);
    const agentData = trends.data[agent];
    if (agentData && agentData.length >= 2) {
      trendHtml = `<div class="chart-box" style="margin-bottom:24px;max-height:200px"><h3>${a.label} Score Trend (Last 14 Days)</h3><canvas id="agentTrendChart" style="max-height:140px"></canvas></div>`;
    }
  } catch {}

  // Try markdown first
  try {
    const mdRes = await fetch(`/api/report/${date}/${agent}/md`);
    if (mdRes.ok) {
      const md = await mdRes.text();
      let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: a.label, hash: `/report/${date}`}, {label: date, hash: `/report/${date}/${agent}`}]);
      html += `<div class="dash-header"><div><h1>${a.icon} ${a.label} Report</h1><div class="date-info">${date}</div></div></div>`;
      html += trendHtml;
      html += `<div class="markdown-body">${marked.parse(md)}</div>`;
      app.innerHTML = html;
      renderAgentTrendChart(agent);
      return;
    }
  } catch {}

  // Fallback JSON
  let report;
  try { report = await api(`/api/report/${date}/${agent}`); } catch (e) { showError('Failed to load report', e.message); return; }
  if (report.error) { app.innerHTML = '<div class="empty"><div class="icon">🔍</div><h3>Report not found</h3></div>'; return; }
  let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: a.label, hash: `/report/${date}`}, {label: date, hash: `/report/${date}/${agent}`}]);
  html += `<div class="dash-header"><div><h1>${a.icon} ${a.label} Report</h1><div class="date-info">${date} · Score: ${report.score ?? '—'}</div></div></div>`;
  html += trendHtml;
  html += `<div class="markdown-body"><pre><code>${JSON.stringify(report.raw, null, 2)}</code></pre></div>`;
  app.innerHTML = html;
  renderAgentTrendChart(agent);
}

// #7: Render per-agent trend chart
async function renderAgentTrendChart(agent) {
  const canvas = $('agentTrendChart');
  if (!canvas) return;
  try {
    const trends = await api(`/api/trends?agent=${agent}&days=14`);
    const agentData = trends.data[agent];
    if (!agentData || agentData.length < 2) return;

    const colors = {
      security: '#f85149', quality: '#3fb950', infra: '#58a6ff',
      dependencies: '#d29922', lighthouse: '#bc8cff', consistency: '#79c0ff', roadmap: '#d2a8ff'
    };
    const color = colors[agent] || '#8b949e';

    charts.push(new Chart(canvas, {
      type: 'line',
      data: {
        labels: agentData.map(d => d.date),
        datasets: [{
          label: AGENTS[agent]?.label || agent,
          data: agentData.map(d => d.score),
          borderColor: color,
          backgroundColor: color + '22',
          tension: .3, fill: true, pointRadius: 4,
          pointBackgroundColor: color
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8b949e', maxTicksLimit: 7 }, grid: { color: 'rgba(48,54,61,.4)' } },
          y: { ticks: { color: '#8b949e' }, grid: { color: 'rgba(48,54,61,.4)' }, min: 0, max: 100 }
        }
      }
    }));
  } catch {}
}

// #9: Trends with date range selector
async function renderTrends() {
  showSkeleton('generic');
  const defaultRange = '30';

  let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: 'Trends', hash: '/trends'}]);
  html += '<div class="dash-header"><h1>Trends</h1></div>';
  html += `<div class="range-selector">
    <button class="range-btn" data-days="7" onclick="filterTrends(7)">7d</button>
    <button class="range-btn active" data-days="30" onclick="filterTrends(30)">30d</button>
    <button class="range-btn" data-days="90" onclick="filterTrends(90)">90d</button>
    <button class="range-btn" data-days="0" onclick="filterTrends(0)">All</button>
  </div>`;
  html += '<div class="chart-grid"><div class="chart-box"><h3>Agent Scores Over Time</h3><canvas id="scoreChart"></canvas></div></div>';
  app.innerHTML = html;

  window._trendRange = 30;
  await loadTrendChart(30);
  app.classList.add('anim-fade-in');
  app.addEventListener('animationend', () => app.classList.remove('anim-fade-in'), { once: true });
}

async function loadTrendChart(days) {
  destroyCharts();
  const url = days > 0 ? `/api/trends?days=${days}` : '/api/trends';
  let trends;
  try { trends = await api(url); } catch { return; }

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
}

function filterTrends(days) {
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days) === days));
  window._trendRange = days;
  loadTrendChart(days);
}

// History
async function renderHistory() {
  showSkeleton('generic');
  let dates;
  try { dates = await api('/api/dates'); } catch (e) { showError('Failed to load history', e.message); return; }

  let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: 'History', hash: '/history'}]);
  html += '<div class="dash-header"><h1>Audit History</h1></div>';
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

// Repo Filter
const REPOS = ['VoltTracker', 'satellite-processor', 'MegaBonk', 'neuhard.dev'];

function renderRepoFilter() {
  const btns = ['all', ...REPOS].map(r => {
    const active = repoFilter === r ? 'active' : '';
    const label = r === 'all' ? 'All' : r;
    return `<button class="repo-btn ${active}" onclick="setRepoFilter('${r}')">${label}</button>`;
  }).join('');
  return `<div class="repo-filter">${btns}</div>`;
}

function setRepoFilter(repo) {
  repoFilter = repo;
  sessionStorage.setItem('repoFilter', repo);
  route();
}

function matchesRepoFilter(text) {
  if (repoFilter === 'all') return true;
  if (!text) return true;
  return text.toLowerCase().includes(repoFilter.toLowerCase());
}

// Diff View (now uses server-side API)
async function renderDiff(date) {
  showSkeleton('generic');
  let diff;
  const url = date ? `/api/diff/${date}` : null;
  if (!url) {
    // Get latest date
    try {
      const dates = await api('/api/dates');
      if (dates.length < 2) {
        app.innerHTML = '<div class="empty"><div class="icon">🔀</div><h3>Need at least 2 audit dates to compare</h3></div>';
        return;
      }
      diff = await api(`/api/diff/${dates[0]}`);
    } catch (e) { showError('Failed to load diff', e.message); return; }
  } else {
    try { diff = await api(url); } catch (e) { showError('Failed to load diff', e.message); return; }
  }

  let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: 'What Changed', hash: `/diff/${diff.date1}`}]);
  html += `<div class="dash-header"><div><h1>🔀 What Changed</h1><div class="date-info">${diff.date2} → ${diff.date1}</div></div></div>`;

  html += '<div class="section"><h2>Score Changes</h2><div class="diff-grid">';
  for (const sc of diff.scoreChanges) {
    const delta = sc.delta;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const cls = delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged';
    const a = AGENTS[sc.agent] || { icon: '📄', label: sc.agent };
    html += `<div class="diff-card ${cls}">
      <div class="diff-agent">${a.icon} ${a.label}</div>
      <div class="diff-scores">${sc.before ?? '—'} → ${sc.after ?? '—'}</div>
      <div class="diff-delta ${cls}">${arrow} ${delta != null ? Math.abs(delta) : '—'}</div>
    </div>`;
  }
  html += '</div></div>';

  if (diff.newFindings.length) {
    html += `<div class="section"><h2 style="color:var(--red)">🆕 New Findings <span class="count">${diff.newFindings.length}</span></h2>`;
    diff.newFindings.forEach(f => { html += renderFinding(f); });
    html += '</div>';
  }
  if (diff.resolvedFindings.length) {
    html += `<div class="section"><h2 style="color:var(--green)">✅ Resolved <span class="count">${diff.resolvedFindings.length}</span></h2>`;
    diff.resolvedFindings.forEach(f => { html += renderFinding(f); });
    html += '</div>';
  }
  if (!diff.newFindings.length && !diff.resolvedFindings.length) {
    html += '<div class="empty" style="padding:40px"><div class="icon">✨</div><h3>No finding changes</h3></div>';
  }

  app.innerHTML = html;
  bindFindingToggles();
}

// #10: Findings Timeline with search
async function renderFindings() {
  showSkeleton('generic');
  let findings;
  try { findings = await api('/api/findings'); } catch (e) { showError('Failed to load findings', e.message); return; }

  window._findingsData = findings;
  window._findingsSort = 'severity';
  window._findingsSearch = '';
  renderFindingsView(findings, 'severity', '');
}

function renderFindingsView(findings, sortBy, searchQuery) {
  let filtered = repoFilter === 'all' ? findings : findings.filter(f => matchesRepoFilter(f.repo));

  // #10: Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(f =>
      (f.title || '').toLowerCase().includes(q) ||
      (f.repo || '').toLowerCase().includes(q) ||
      (f.description || '').toLowerCase().includes(q)
    );
  }

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'severity') return (severityRank(a.severity) - severityRank(b.severity));
    if (sortBy === 'firstSeen') return a.firstSeen.localeCompare(b.firstSeen);
    if (sortBy === 'status') {
      const order = { 'new': 0, recurring: 1, resolved: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    }
    return 0;
  });

  let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: 'Findings', hash: '/findings'}]);
  html += `<div class="dash-header"><div><h1>📋 Findings Timeline</h1><div class="date-info">${filtered.length} findings tracked</div></div></div>`;
  html += renderRepoFilter();

  // Search input
  html += `<div class="search-bar"><input type="text" id="findings-search" class="search-input" placeholder="Search findings by title, repo, or description..." value="${searchQuery || ''}"></div>`;

  html += `<div class="sort-bar">Sort: 
    <button class="sort-btn ${sortBy === 'severity' ? 'active' : ''}" onclick="sortFindings('severity')">Severity</button>
    <button class="sort-btn ${sortBy === 'firstSeen' ? 'active' : ''}" onclick="sortFindings('firstSeen')">First Seen</button>
    <button class="sort-btn ${sortBy === 'status' ? 'active' : ''}" onclick="sortFindings('status')">Status</button>
  </div>`;

  if (!sorted.length) {
    html += '<div class="empty"><div class="icon">✨</div><h3>No findings</h3></div>';
  } else {
    html += '<div class="findings-timeline">';
    for (const f of sorted) {
      const statusCls = f.status === 'new' ? 'badge-high' : f.status === 'recurring' ? 'badge-medium' : 'badge-info';
      const statusLabel = f.status.charAt(0).toUpperCase() + f.status.slice(1);
      html += `<div class="timeline-item">
        <div class="timeline-header">
          ${severityBadge(f.severity)}
          <span class="badge ${statusCls}">${statusLabel}</span>
          <span class="finding-title">${f.title}</span>
        </div>
        <div class="timeline-meta">
          <span>${f.repo || '—'}</span>
          <span>First: ${f.firstSeen}</span>
          <span>Last: ${f.lastSeen}</span>
          <span>×${f.occurrences}</span>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  app.innerHTML = html;

  // Bind search with debounce
  let searchTimer;
  const searchInput = $('findings-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        window._findingsSearch = e.target.value;
        renderFindingsView(window._findingsData || [], window._findingsSort, e.target.value);
        // Restore focus
        const el = $('findings-search');
        if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
      }, 200);
    });
  }
}

function sortFindings(by) {
  window._findingsSort = by;
  renderFindingsView(window._findingsData || [], by, window._findingsSearch || '');
}

// #13: Calendar improvements
async function renderCalendar() {
  showSkeleton('generic');
  let trends;
  try { trends = await api('/api/trends'); } catch (e) { showError('Failed to load data', e.message); return; }

  const dateScores = {};
  for (const date of (trends.dates || [])) {
    const agents = Object.values(trends.data || {});
    let total = 0, count = 0;
    let hasCritical = false;
    for (const agentData of agents) {
      const entry = agentData.find(d => d.date === date);
      if (entry) {
        if (entry.score != null) { total += entry.score; count++; }
        if (entry.status === 'critical') hasCritical = true;
      }
    }
    const avg = count ? Math.round(total / count) : null;
    let status = 'none';
    if (avg != null) {
      if (avg >= 90) status = 'excellent';
      else if (avg >= 80) status = 'good';
      else if (avg >= 60) status = 'fair';
      else if (avg >= 40) status = 'warning';
      else status = 'critical';
    }
    if (hasCritical && status !== 'critical') status = 'critical';
    dateScores[date] = { avg, hasCritical, status };
  }

  // Build 90-day grid
  const now = new Date();
  const days = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    days.push({ date: ds, dow, info: dateScores[ds] || { avg: null, status: 'none' }, month: d.getMonth(), year: d.getFullYear() });
  }

  let html = renderBreadcrumbs([{label: 'Dashboard', hash: '/'}, {label: 'Calendar', hash: '/calendar'}]);
  html += '<div class="dash-header"><div><h1>📅 Audit Calendar</h1><div class="date-info">Last 90 days</div></div></div>';
  html += '<div class="calendar-heatmap"><div class="calendar-grid">';

  // Group by weeks
  const weeks = [];
  let currentWeek = [];
  for (const day of days) {
    if (currentWeek.length && day.dow === 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(day);
  }
  if (currentWeek.length) weeks.push(currentWeek);

  // Pad first week
  if (weeks[0] && weeks[0][0]) {
    const pad = weeks[0][0].dow;
    for (let i = 0; i < pad; i++) weeks[0].unshift(null);
  }

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  html += '<div class="cal-labels">';
  for (let i = 0; i < 7; i++) html += `<div class="cal-label">${dayLabels[i]}</div>`;
  html += '</div>';

  // #13: Month labels
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  html += '<div class="cal-column"><div class="cal-month-row">';
  let lastMonth = -1;
  for (const week of weeks) {
    const firstDay = week.find(d => d != null);
    if (firstDay && firstDay.month !== lastMonth) {
      html += `<div class="cal-month-label">${monthNames[firstDay.month]}</div>`;
      lastMonth = firstDay.month;
    } else {
      html += '<div class="cal-month-label"></div>';
    }
  }
  html += '</div>';

  html += '<div class="cal-weeks">';
  for (const week of weeks) {
    html += '<div class="cal-week">';
    for (const day of week) {
      if (!day) {
        html += '<div class="cal-day empty"></div>';
      } else {
        const cls = `cal-${day.info.status}`;
        const scoreText = day.info.avg != null ? `Score: ${day.info.avg}` : 'No data';
        const hasData = day.info.status !== 'none';
        html += `<div class="cal-day ${cls}" data-tooltip="${day.date} — ${scoreText}" ${hasData ? `onclick="navigate('/report/${day.date}')"` : ''}></div>`;
      }
    }
    html += '</div>';
  }
  html += '</div></div></div>';

  // Legend with 5 colors
  html += `<div class="cal-legend">
    <span class="cal-legend-item"><span class="cal-day cal-none" style="display:inline-block"></span> No data</span>
    <span class="cal-legend-item"><span class="cal-day cal-excellent" style="display:inline-block"></span> Excellent (90+)</span>
    <span class="cal-legend-item"><span class="cal-day cal-good" style="display:inline-block"></span> Good (80-89)</span>
    <span class="cal-legend-item"><span class="cal-day cal-fair" style="display:inline-block"></span> Fair (60-79)</span>
    <span class="cal-legend-item"><span class="cal-day cal-warning" style="display:inline-block"></span> Warning (40-59)</span>
    <span class="cal-legend-item"><span class="cal-day cal-critical" style="display:inline-block"></span> Critical (<40)</span>
  </div>`;

  html += '</div>';
  app.innerHTML = html;
}

// Version display
async function loadVersion() {
  try {
    const { version, buildDate } = await api('/api/version');
    const el = document.getElementById('version-footer');
    if (el) {
      let text = version ? `v${version}` : '';
      if (buildDate) {
        const d = new Date(buildDate);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        text += ` · Built ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
      }
      el.textContent = text;
    }
  } catch {}
}

// #15: Mobile hamburger
function initMobileNav() {
  const toggle = $('nav-toggle');
  const links = $('nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('nav-open');
      toggle.classList.toggle('active');
    });
    // Close on nav link click
    links.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        links.classList.remove('nav-open');
        toggle.classList.remove('active');
      });
    });
  }
}

// Init
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { route(); loadVersion(); initMobileNav(); });
