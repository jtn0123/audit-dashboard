/* Shared helpers, the hash router and boot.
   View modules: repos.js (patch board, PRs, coverage, settings)
                 insights.js (posture, trends, history, findings, calendar) */

const $ = id => document.getElementById(id);
const app = $('app');
let charts = [];

/**
 * Escape before interpolating anything that came from GitHub into HTML *text*
 * or an ordinary attribute value. NOT sufficient inside an inline event
 * handler — see jsAttr below.
 */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

/**
 * Escape for a single-quoted JS string inside an inline handler, e.g.
 * onclick="fn('${jsAttr(name)}')".
 *
 * esc() alone is not enough there: the parser HTML-decodes the attribute
 * *before* compiling it as JS, so an escaped `&#39;` turns back into a real
 * quote and closes the string. Backslash-escaping first means the quote
 * survives decoding as an escaped quote rather than a delimiter.
 */
const jsAttr = s => esc(
  String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\\'')
    .replace(/[\r\n\u2028\u2029]/g, ' ')
);

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function navigate(path) { window.location.hash = path; }
function getRoute() { return window.location.hash.slice(1) || '/'; }

async function api(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body.error) detail = body.hint ? `${body.error} — ${body.hint}` : body.error;
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return r.json();
}

function showError(message, detail) {
  app.innerHTML = `<div class="empty"><div class="icon">⚠️</div><h3>${esc(message)}</h3>
    <p style="color:var(--text-muted);max-width:500px">${esc(detail || 'Try refreshing the page.')}</p>
    <button class="refresh-btn" onclick="route()" style="margin-top:16px">↻ Retry</button></div>`;
}

window.addEventListener('unhandledrejection', (e) => {
  console.warn('Unhandled rejection:', e.reason);
  showError('Something went wrong', e.reason?.message || String(e.reason));
});

/**
 * Chart instances are created in insights.js but owned here, so that creating
 * and destroying them live together — a view pushing straight onto the shared
 * array left no visible writer beside the declaration.
 */
function trackChart(chart) {
  charts.push(chart);
  return chart;
}

function destroyCharts() {
  charts.forEach(c => { try { c.destroy(); } catch { /* already gone */ } });
  charts = [];
}

function severityBadge(sev) {
  const s = String(sev || 'info').toLowerCase();
  const known = SEVERITY_ORDER.includes(s) ? s : 'info';
  return `<span class="badge badge-${known}">${esc(sev || 'info')}</span>`;
}

function severityRank(s) {
  const i = SEVERITY_ORDER.indexOf(String(s || '').toLowerCase());
  return i === -1 ? 4 : i;
}

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

/** "3 Aug", "3 Aug 2025" when the year differs from now. */
function shortDate(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}${sameYear ? '' : ' ' + d.getUTCFullYear()}`;
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

function renderSeverityBar(counts) {
  const total = SEVERITY_ORDER.reduce((sum, s) => sum + (counts[s] || 0), 0);
  if (!total) return '';
  const pct = n => ((n / total) * 100).toFixed(1);
  const title = SEVERITY_ORDER.map(s => `${s[0].toUpperCase()}${s.slice(1)}: ${counts[s] || 0}`).join(' · ');
  return `<div class="severity-bar" title="${esc(title)}">
    ${SEVERITY_ORDER.map(s => counts[s]
    ? `<div class="sev-seg sev-${s}" style="width:${pct(counts[s])}%"></div>` : '').join('')}
  </div>`;
}

function skeletonGeneric(n = 4) {
  return `<div class="skeleton skeleton-text" style="height:24px;margin-bottom:20px;width:200px"></div>
  ${Array(n).fill('<div class="skeleton" style="height:80px;margin-bottom:8px"></div>').join('')}`;
}

function showLoading(label) {
  app.innerHTML = `<div class="loading"><div class="spinner"></div>${esc(label || 'Loading…')}</div>`;
}

/**
 * Shared header for every GitHub-backed view.
 * `sub` is interpolated as HTML so callers can include links — callers must
 * esc() anything inside it that came from GitHub.
 */
function viewHeader(title, sub, { rescan = true } = {}) {
  return `<div class="patch-header">
    <div>
      <h2 class="patch-title">${esc(title)}</h2>
      <div class="patch-sub">${sub}</div>
    </div>
    ${rescan ? '<button class="refresh-btn" onclick="refreshGitHub(this)">↻ Rescan</button>' : ''}
  </div>`;
}

/**
 * A short explanation of where a view's numbers come from. `text` is trusted
 * HTML written in this file — never pass GitHub-sourced strings through it
 * unescaped.
 */
function noteBanner(text, tone = 'info') {
  return `<div class="note note-${tone}">${text}</div>`;
}

const CHART_COLORS = {
  critical: '#f85149', high: '#db6d28', medium: '#d29922', low: '#3fb950',
  total: '#58a6ff', merged: '#3fb950', opened: '#bc8cff', coverage: '#79c0ff'
};

const CHART_BASE = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { labels: { color: '#8b949e', usePointStyle: true, boxWidth: 8, padding: 14 } },
    tooltip: { backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#8b949e' }
  },
  scales: {
    x: { ticks: { color: '#8b949e', maxRotation: 0, autoSkipPadding: 24 }, grid: { color: 'rgba(48,54,61,.35)' } },
    y: { ticks: { color: '#8b949e', precision: 0 }, grid: { color: 'rgba(48,54,61,.35)' }, beginAtZero: true }
  }
};

// === Router ==============================================================

const ROUTES = [
  { path: '/', nav: 'nav-patch', render: () => renderPatch() },
  { path: '/patch', nav: 'nav-patch', render: () => renderPatch() },
  { path: '/prs', nav: 'nav-prs', render: () => renderPrs() },
  { path: '/coverage', nav: 'nav-coverage', render: () => renderCoverage() },
  { path: '/posture', nav: 'nav-posture', render: () => renderPosture() },
  { path: '/trends', nav: 'nav-trends', render: () => renderTrends() },
  { path: '/history', nav: 'nav-history', render: () => renderHistory() },
  { path: '/findings', nav: 'nav-findings', render: () => renderFindings() },
  { path: '/calendar', nav: 'nav-calendar', render: () => renderCalendar() },
  { path: '/settings', nav: 'nav-settings', render: () => renderSettings() }
];

// The audit-era views were replaced by GitHub-backed ones; keep old bookmarks working.
const REDIRECTS = { '/audits': '/posture', '/dashboard': '/posture', '/diff': '/history' };

async function route() {
  destroyCharts();
  let path = getRoute();
  const base = '/' + path.split('/')[1];
  if (REDIRECTS[path] || REDIRECTS[base]) {
    window.location.replace(`#${REDIRECTS[path] || REDIRECTS[base]}`);
    return;
  }

  document.querySelectorAll('nav a[id]').forEach(a => {
    a.classList.remove('active');
    a.removeAttribute('aria-current');
  });

  // An unrecognised hash used to render the patch board while leaving the bogus
  // hash in the address bar, so a typo looked like a working page.
  const match = ROUTES.find(r => r.path === path);
  if (!match) {
    window.location.replace('#/');
    return;
  }
  const link = $(match.nav);
  if (link) { link.classList.add('active'); link.setAttribute('aria-current', 'page'); }
  document.title = match.path === '/' ? 'Patch Board' : `${link?.textContent.trim() || 'Patch Board'} · Patch Board`;

  try {
    await match.render();
  } catch (e) {
    showError('This view failed to load', e.message);
  }
}

async function loadVersion() {
  try {
    const { version, buildDate } = await api('/api/version');
    const el = $('version-footer');
    if (!el) return;
    let text = version ? `v${version}` : '';
    if (buildDate) text += ` · Built ${shortDate(buildDate)}`;
    el.textContent = text;
  } catch { /* footer is cosmetic */ }
}

function initMobileNav() {
  const toggle = $('nav-toggle');
  const links = $('nav-links');
  if (!toggle || !links) return;
  const close = () => {
    links.classList.remove('nav-open');
    toggle.classList.remove('active');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('nav-open');
    toggle.classList.toggle('active', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { route(); loadVersion(); initMobileNav(); });
