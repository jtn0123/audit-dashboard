const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const PORT = process.env.PORT || 3002;

const pkg = require('./package.json');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/version', (req, res) => res.json({ version: pkg.version, buildDate: process.env.BUILD_DATE || null }));

// List dates
app.get('/api/dates', (req, res) => {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const dates = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map(e => e.name).sort().reverse();
    res.json(dates);
  } catch { res.json([]); }
});

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

// All reports for a date
app.get('/api/report/:date', (req, res) => {
  const dir = path.join(DATA_DIR, req.params.date);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const reports = [];
    for (const f of files) {
      try {
        const name = f.replace('.json', '');
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        reports.push(normalize(name, data));
      } catch (e) { console.warn(`Error reading ${f}:`, e.message); }
    }
    res.json(reports);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

// Trends
app.get('/api/trends', (req, res) => {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const dates = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map(e => e.name).sort();
    const trends = { dates: [], data: {} };
    for (const date of dates) {
      trends.dates.push(date);
      const files = fs.readdirSync(path.join(DATA_DIR, date)).filter(f => f.endsWith('.json') && f !== 'meta.json');
      for (const f of files) {
        try {
          const name = f.replace('.json', '');
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

// Findings timeline
app.get('/api/findings', (_req, res) => {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const dates = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map(e => e.name).sort();
    if (!dates.length) return res.json([]);
    const latestDate = dates[dates.length - 1];
    const findingsMap = {}; // key: title -> aggregated info

    for (const date of dates) {
      const dir = path.join(DATA_DIR, date);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'meta.json');
      for (const f of files) {
        try {
          const agentName = f.replace('.json', '');
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          let findings = [];
          // Extract findings from different agent types
          if (Array.isArray(data.findings)) {
            findings = data.findings;
          } else if (data.findings && typeof data.findings === 'object') {
            // consistency has findings as object of arrays
            for (const arr of Object.values(data.findings)) {
              if (Array.isArray(arr)) findings.push(...arr);
            }
          }
          // Also check repos for quality agent
          if (Array.isArray(data.repos)) {
            for (const repo of data.repos) {
              if (Array.isArray(repo.findings)) findings.push(...repo.findings.map(ff => ({ ...ff, repo: repo.name || repo.repo })));
            }
          }
          // Roadmap priorities as findings
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

    // Compute status
    const result = Object.values(findingsMap).map(f => {
      if (f.lastSeen !== latestDate) f.status = 'resolved';
      else if (f.firstSeen === latestDate) f.status = 'new';
      else f.status = 'recurring';
      return f;
    });

    // Sort by severity
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    result.sort((a, b) => (sevOrder[a.severity] ?? 5) - (sevOrder[b.severity] ?? 5));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Audit dashboard on port ${PORT}`));
