const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const pkg = require('./package.json');

app.use(express.static(path.join(__dirname, 'public')));

// Helper: get sorted date dirs
function getDates() {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name).sort();
  } catch { return []; }
}

// Helper: get all reports for a date
function getReportsForDate(date) {
  const dir = path.join(DATA_DIR, date);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const reports = [];
  for (const f of files) {
    try {
      const name = f.replace('.json', '');
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      reports.push(normalize(name, data));
    } catch {}
  }
  return reports;
}

// Helper: calc health score from reports
function calcHealthScore(reports) {
  const scores = reports.filter(r => r.agent !== 'meta' && r.agent !== 'digest' && r.score != null).map(r => r.score);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// Helper: get meta info
function getMetaInfo(reports) {
  const meta = reports.find(r => r.agent === 'meta');
  const raw = meta?.raw || {};
  return {
    lastRunTime: raw.endTime || null,
    lastRunDuration: raw.durationSeconds || null
  };
}

// Helper: grade from score
function gradeFromScore(score) {
  if (score == null) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// Helper: collect all findings across all dates
function collectAllFindings() {
  const dates = getDates();
  if (!dates.length) return [];
  const latestDate = dates[dates.length - 1];
  const findingsMap = {};

  for (const date of dates) {
    const dir = path.join(DATA_DIR, date);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'meta.json'); } catch { continue; }
    for (const f of files) {
      try {
        const agentName = f.replace('.json', '');
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        let findings = [];
        if (Array.isArray(data.findings)) {
          findings = data.findings;
        } else if (data.findings && typeof data.findings === 'object') {
          for (const arr of Object.values(data.findings)) {
            if (Array.isArray(arr)) findings.push(...arr);
          }
        }
        if (Array.isArray(data.repos)) {
          for (const repo of data.repos) {
            if (Array.isArray(repo.findings)) findings.push(...repo.findings.map(ff => ({ ...ff, repo: repo.name || repo.repo })));
          }
        }
        if (Array.isArray(data.priorities)) {
          findings.push(...data.priorities.map(p => ({ severity: p.severity || 'medium', title: p.title, repo: p.repo })));
        }

        for (const finding of findings) {
          const title = finding.title || finding.id || 'Unknown';
          const key = title.toLowerCase().trim();
          if (!findingsMap[key]) {
            findingsMap[key] = {
              id: finding.id || key.slice(0, 8),
              title,
              severity: finding.severity || 'info',
              repo: finding.repo || agentName,
              agent: agentName,
              firstSeen: date,
              lastSeen: date,
              occurrences: 1,
              status: 'new'
            };
          } else {
            findingsMap[key].lastSeen = date;
            findingsMap[key].occurrences++;
            if (!findingsMap[key].repo && finding.repo) findingsMap[key].repo = finding.repo;
          }
        }
      } catch {}
    }
  }

  const result = Object.values(findingsMap).map(f => {
    if (f.lastSeen !== latestDate) f.status = 'resolved';
    else if (f.firstSeen === latestDate) f.status = 'new';
    else f.status = 'recurring';
    return f;
  });

  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  result.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));
  return result;
}

// Helper: finding counts from security report
function getFindingCounts(reports) {
  const sec = reports.find(r => r.agent === 'security');
  const counts = sec?.findingCounts || {};
  return { critical: counts.critical || 0, high: counts.high || 0, medium: counts.medium || 0, low: counts.low || 0 };
}

function normalize(name, data) {
  const base = { agent: name, raw: data };
  try {
    switch (name) {
      case 'security': {
        const s = data.summary || {};
        const score = Math.max(0, 100 - (s.critical||0)*25 - (s.high||0)*10 - (s.medium||0)*5 - (s.low||0)*2);
        return { ...base, status: s.critical > 0 ? 'critical' : s.high > 0 ? 'warning' : 'ok',
          score, summary: `${s.total||0} findings: ${s.critical||0}C / ${s.high||0}H / ${s.medium||0}M / ${s.low||0}L`,
          findings: data.findings || [], findingCounts: s };
      }
      case 'quality':
        return { ...base, status: (data.score||0) >= 85 ? 'ok' : (data.score||0) >= 70 ? 'warning' : 'critical',
          score: data.score||0, grade: data.grade, summary: data.summary || '', repos: data.repos || [] };
      case 'infra': {
        const ciEntries = Object.values(data.ci || {});
        const avgCI = ciEntries.length ? ciEntries.reduce((a,c) => a + (c.successRate||0), 0) / ciEntries.length : 0;
        const containers = data.containers || [];
        const running = containers.filter(c => c.state === 'running').length;
        const score = Math.round(avgCI * 70 + (running === containers.length && containers.length > 0 ? 30 : 0));
        const hasCrit = (data.alerts||[]).some(a => a.severity === 'critical');
        return { ...base, status: hasCrit ? 'critical' : avgCI < 0.7 ? 'warning' : 'ok',
          score, summary: `${running}/${containers.length} containers · CI avg ${Math.round(avgCI*100)}%`,
          ci: data.ci, containers, alerts: data.alerts || [], disk: data.disk };
      }
      case 'dependencies': {
        const s = data.summary || {};
        const total = s.totalVulnerabilities || 0;
        const score = Math.max(0, 100 - (s.critical||0)*25 - (s.high||0)*2 - (s.moderate||0));
        return { ...base, status: (s.critical||0) > 0 ? 'critical' : (s.high||0) > 0 ? 'warning' : 'ok',
          score, summary: `${total} vulns: ${s.critical||0}C / ${s.high||0}H / ${s.moderate||0}M`,
          repos: data.repos || {}, depSummary: s };
      }
      case 'lighthouse': {
        const sites = data.sites || {};
        const entries = Object.entries(sites).filter(([,v]) => v.scores);
        const avg = entries.length ? Math.round(entries.reduce((a,[,v]) => a + (v.scores.performance||0), 0) / entries.length) : 0;
        return { ...base, status: avg >= 80 ? 'ok' : avg >= 50 ? 'warning' : 'critical',
          score: avg, summary: `Avg perf: ${avg}`, sites };
      }
      case 'consistency':
        return { ...base, status: (data.consistencyScore||0) >= 70 ? 'ok' : (data.consistencyScore||0) >= 50 ? 'warning' : 'critical',
          score: data.consistencyScore||0, summary: data.summary || '',
          findings: data.findings || {}, recommendations: data.recommendations || [] };
      case 'roadmap':
        return { ...base, status: (data.portfolioHealth||0) >= 70 ? 'ok' : (data.portfolioHealth||0) >= 50 ? 'warning' : 'critical',
          score: data.portfolioHealth||0, summary: `Portfolio health: ${data.portfolioHealth||0}%`,
          healthScores: data.healthScores || {}, priorities: data.priorities || [], quickWins: data.quickWins || [] };
      case 'digest':
        return { ...base, status: 'ok', score: null, summary: '',
          healthScores: data.healthScores || {}, topPriorities: data.topPriorities || [] };
      case 'meta':
        return { ...base, status: 'ok' };
      default:
        return base;
    }
  } catch (e) {
    console.warn(`normalize error for ${name}:`, e.message);
    return { ...base, status: 'unknown', score: null, summary: 'Error normalizing' };
  }
}

// === API Endpoints ===

// #4: Enriched health
app.get('/health', (req, res) => {
  const dates = getDates();
  const latestDate = dates[dates.length - 1] || null;
  const reports = latestDate ? getReportsForDate(latestDate) : [];
  const metaInfo = getMetaInfo(reports);
  const healthScore = calcHealthScore(reports);
  const agentReports = reports.filter(r => r.agent !== 'meta' && r.agent !== 'digest');
  res.json({
    status: 'ok',
    version: pkg.version,
    buildDate: process.env.BUILD_DATE || null,
    lastAuditDate: latestDate,
    lastRunTime: metaInfo.lastRunTime,
    lastRunDuration: metaInfo.lastRunDuration,
    healthScore,
    agentCount: agentReports.length,
    findingCounts: getFindingCounts(reports)
  });
});

app.get('/api/version', (req, res) => res.json({ version: pkg.version, buildDate: process.env.BUILD_DATE || null }));

// List dates
app.get('/api/dates', (req, res) => {
  res.json(getDates().reverse());
});

// #1: Summary endpoint
app.get('/api/summary', (req, res) => {
  const dates = getDates();
  if (!dates.length) return res.json({ error: 'No data' });
  const latestDate = dates[dates.length - 1];
  const reports = getReportsForDate(latestDate);
  const healthScore = calcHealthScore(reports);
  const metaInfo = getMetaInfo(reports);

  // Delta from previous date
  let delta = null;
  if (dates.length >= 2) {
    const prevReports = getReportsForDate(dates[dates.length - 2]);
    const prevScore = calcHealthScore(prevReports);
    if (healthScore != null && prevScore != null) delta = healthScore - prevScore;
  }

  const agents = reports
    .filter(r => r.agent !== 'meta' && r.agent !== 'digest')
    .map(r => ({ name: r.agent, score: r.score, grade: r.grade || gradeFromScore(r.score), status: r.status }));

  // Top priorities from digest or roadmap
  const digest = reports.find(r => r.agent === 'digest');
  const roadmap = reports.find(r => r.agent === 'roadmap');
  const topPriorities = digest?.topPriorities || roadmap?.priorities?.slice(0, 5)?.map(p => p.title) || [];

  res.json({
    date: latestDate,
    healthScore,
    delta,
    agents,
    findingCounts: getFindingCounts(reports),
    topPriorities,
    lastRunDuration: metaInfo.lastRunDuration,
    lastRunTime: metaInfo.lastRunTime
  });
});

// #2: Findings with query params
app.get('/api/findings', (req, res) => {
  try {
    let findings = collectAllFindings();
    const { status, severity, repo, agent, limit, sort } = req.query;

    if (status) findings = findings.filter(f => f.status === status);
    if (severity) findings = findings.filter(f => f.severity === severity);
    if (repo) findings = findings.filter(f => f.repo && f.repo.toLowerCase().includes(repo.toLowerCase()));
    if (agent) findings = findings.filter(f => f.agent && f.agent.toLowerCase() === agent.toLowerCase());

    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    if (sort === 'firstSeen') findings.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    else if (sort === 'status') {
      const sOrder = { 'new': 0, recurring: 1, resolved: 2 };
      findings.sort((a, b) => (sOrder[a.status] ?? 3) - (sOrder[b.status] ?? 3));
    } else {
      findings.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));
    }

    if (limit) findings = findings.slice(0, parseInt(limit, 10));
    res.json(findings);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// #3: Diff endpoint
app.get('/api/diff/:date1/:date2?', (req, res) => {
  try {
    const dates = getDates();
    const date1 = req.params.date1;
    let date2 = req.params.date2;
    if (!date2) {
      const idx = dates.indexOf(date1);
      date2 = idx > 0 ? dates[idx - 1] : null;
    }
    if (!date2) return res.status(400).json({ error: 'No previous date available' });

    const reports1 = getReportsForDate(date1);
    const reports2 = getReportsForDate(date2);

    const AGENT_ORDER = ['security', 'quality', 'infra', 'dependencies', 'lighthouse', 'consistency', 'roadmap'];
    const byAgent1 = {}; reports1.forEach(r => { byAgent1[r.agent] = r; });
    const byAgent2 = {}; reports2.forEach(r => { byAgent2[r.agent] = r; });

    const scoreChanges = AGENT_ORDER.map(agent => ({
      agent,
      before: byAgent2[agent]?.score ?? null,
      after: byAgent1[agent]?.score ?? null,
      delta: (byAgent1[agent]?.score != null && byAgent2[agent]?.score != null) ? byAgent1[agent].score - byAgent2[agent].score : null
    }));

    // Collect findings
    function collectFromReports(reports) {
      const findings = [];
      for (const r of reports) {
        if (Array.isArray(r.findings)) findings.push(...r.findings.map(f => ({ ...f, agent: r.agent })));
        if (r.findings && typeof r.findings === 'object' && !Array.isArray(r.findings)) {
          for (const arr of Object.values(r.findings)) {
            if (Array.isArray(arr)) findings.push(...arr.map(f => ({ ...f, agent: r.agent })));
          }
        }
        if (Array.isArray(r.priorities)) {
          findings.push(...r.priorities.map(p => ({ severity: p.severity || 'medium', title: p.title, repo: p.repo, agent: r.agent })));
        }
      }
      return findings;
    }

    const findings1 = collectFromReports(reports1);
    const findings2 = collectFromReports(reports2);
    const titles2 = new Set(findings2.map(f => (f.title || '').toLowerCase()));
    const titles1 = new Set(findings1.map(f => (f.title || '').toLowerCase()));

    res.json({
      date1,
      date2,
      scoreChanges,
      newFindings: findings1.filter(f => !titles2.has((f.title || '').toLowerCase())),
      resolvedFindings: findings2.filter(f => !titles1.has((f.title || '').toLowerCase()))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// #5: Trends with filtering
app.get('/api/trends', (req, res) => {
  try {
    let dates = getDates();
    const { days, agent: agentParam, agents: agentsParam } = req.query;

    if (days) {
      const n = parseInt(days, 10);
      if (n > 0 && dates.length > n) dates = dates.slice(-n);
    }

    const agentFilter = agentParam ? [agentParam] : agentsParam ? agentsParam.split(',') : null;

    const trends = { dates: [], data: {} };
    for (const date of dates) {
      trends.dates.push(date);
      let files;
      try { files = fs.readdirSync(path.join(DATA_DIR, date)).filter(f => f.endsWith('.json') && f !== 'meta.json'); } catch { continue; }
      for (const f of files) {
        try {
          const name = f.replace('.json', '');
          if (agentFilter && !agentFilter.includes(name)) continue;
          const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, date, f), 'utf8'));
          const n = normalize(name, raw);
          if (!trends.data[name]) trends.data[name] = [];
          trends.data[name].push({ date, score: n.score, status: n.status });
        } catch {}
      }
    }
    res.json(trends);
  } catch { res.json({ dates: [], data: {} }); }
});

// All reports for a date
app.get('/api/report/:date', (req, res) => {
  const reports = getReportsForDate(req.params.date);
  if (!reports.length) return res.status(404).json({ error: 'Not found' });
  res.json(reports);
});

// Single agent
app.get('/api/report/:date/:agent', (req, res) => {
  const fp = path.join(DATA_DIR, req.params.date, `${req.params.agent}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    res.json(normalize(req.params.agent, data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Markdown
app.get('/api/report/:date/:agent/md', (req, res) => {
  const fp = path.join(DATA_DIR, req.params.date, `${req.params.agent}.md`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain').send(fs.readFileSync(fp, 'utf8'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Audit dashboard on port ${PORT}`));
