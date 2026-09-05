const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.PORT = '0';
// Keep the GitHub collector inert: these tests cover routing and degraded states.
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
process.env.GH_AUTO_REFRESH = 'false';

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function post(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function getJSON(port, urlPath) {
  const r = await get(port, urlPath);
  return { ...r, json: JSON.parse(r.body) };
}

let server;
let port;

before(async () => {
  // Clear require cache so env vars take effect
  delete require.cache[require.resolve('../server.js')];

  // Capture the server from listen
  const express = require('express');
  const originalListen = express.application.listen;
  await new Promise((resolve) => {
    express.application.listen = function (..._args) {
      server = originalListen.call(this, 0, () => {
        port = server.address().port;
        resolve();
      });
      return server;
    };
    require('../server.js');
  });
});

after(() => {
  if (!server) return;
  // Keep-alive sockets outlive close(); without this the process never exits.
  server.closeAllConnections?.();
  server.close();
});

describe('API tests', () => {
  it('GET /health returns 200 with status ok', async () => {
    const r = await getJSON(port, '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
  });

  it('GET /healthz returns 200 liveness probe', async () => {
    const r = await getJSON(port, '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: 'ok' });
  });

  it('GET /api/digest.md degrades honestly when unconfigured', async () => {
    const r = await get(port, '/api/digest.md');
    assert.equal(r.status, 200);
    assert.match(r.body, /not configured/);
  });

  it('GET /llms.txt serves the agent contract', async () => {
    const r = await get(port, '/llms.txt');
    assert.equal(r.status, 200);
    assert.match(r.body, /work queue/i);
    assert.match(r.body, /refresh-then-read/);
  });

  it('the removed audit endpoints answer 404 JSON, not the SPA shell', async () => {
    for (const p of ['/api/dates', '/api/summary', '/api/findings', '/api/trends', '/api/report/2026-01-01']) {
      const r = await getJSON(port, p);
      assert.equal(r.status, 404, `${p} should be 404`);
      assert.match(r.json.error, /No such endpoint/);
    }
  });

  it('unknown /api paths never serve HTML', async () => {
    // The SPA catch-all used to swallow these, so a mistyped or removed
    // endpoint answered 200 text/html and looked like a success.
    for (const p of ['/api', '/api/', '/api/nope', '/api/gh/nope', '/api/gh/alerts/extra']) {
      const r = await get(port, p);
      assert.equal(r.status, 404, `${p} should be 404`);
      assert.ok(r.headers['content-type'].includes('json'), `${p} should answer JSON`);
    }
  });

  it('path-traversal attempts cannot read files off disk', async () => {
    const payloads = [
      '/api/report/..%2f..%2f..%2f..%2fpackage',
      '/api/report/2026-01-01/../../../package',
      '/../server.js',
      '/..%2fserver.js',
      '/vendor/../../lib/settings.js',
      '/js/../../.env'
    ];
    for (const p of payloads) {
      const r = await get(port, p);
      assert.ok(!/GITHUB_TOKEN|githubToken|require\(|"dependencies"/.test(r.body),
        `${p} leaked file contents`);
    }
  });

  it('GET /health reports collector state instead of audit files', async () => {
    const r = await getJSON(port, '/health');
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.alerts.total, 'number');
    assert.equal(typeof r.json.openPrs, 'number');
    assert.ok('coveragePercent' in r.json);
    assert.equal(typeof r.json.history.count, 'number');
    assert.ok(!('lastAuditDate' in r.json), 'audit-era fields should be gone');
  });

});

describe('GitHub API tests (unconfigured)', () => {
  it('GET /api/gh/status answers even with no token', async () => {
    const r = await getJSON(port, '/api/gh/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
    assert.equal(r.json.repoCount, 0);
  });

  it('GET /health reports GitHub integration state', async () => {
    const r = await getJSON(port, '/health');
    assert.equal(r.json.github.configured, false);
  });

  it('data endpoints return 503 with a setup hint when unconfigured', async () => {
    for (const p of ['/api/gh/repos', '/api/gh/overview', '/api/gh/prs', '/api/gh/alerts', '/api/gh/coverage',
      '/api/gh/posture', '/api/gh/trends', '/api/gh/history', '/api/gh/calendar', '/api/gh/merges']) {
      const r = await getJSON(port, p);
      assert.equal(r.status, 503, `${p} should be 503`);
      assert.match(r.json.hint, /GITHUB_TOKEN/);
    }
  });

  it('POST /api/gh/refresh returns 503 when unconfigured', async () => {
    const r = await post(port, '/api/gh/refresh');
    assert.equal(r.status, 503);
  });
});

describe('Static file tests', () => {
  it('serves the SPA for nested non-API routes', async () => {
    for (const p of ['/repos/example/details', '/apiary']) {
      const r = await get(port, p);
      assert.equal(r.status, 200);
      assert.ok(r.headers['content-type'].includes('html'));
      assert.ok(r.body.includes('app.js'));
    }
  });

  it('GET / returns HTML containing app.js', async () => {
    const r = await get(port, '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('app.js'));
  });

  it('GET /css/style.css returns CSS', async () => {
    const r = await get(port, '/css/style.css');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('css'));
  });

  it('settings view links to GitHub fine-grained token creation', async () => {
    const r = await get(port, '/js/repos.js');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('personal-access-tokens/new'));
    assert.ok(r.body.includes('vulnerability_alerts=read'));
  });

  it('GET /js/app.js returns JavaScript', async () => {
    const r = await get(port, '/js/app.js');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('javascript'));
  });

  it('GET /js/insights.js serves the posture/trends/history/findings/calendar views', async () => {
    const r = await get(port, '/js/insights.js');
    assert.equal(r.status, 200);
    for (const fn of ['renderPosture', 'renderTrends', 'renderHistory', 'renderFindings', 'renderCalendar']) {
      assert.ok(r.body.includes(`function ${fn}`), `${fn} should be defined`);
    }
  });

  it('index.html wires all three scripts and no dead audit nav', async () => {
    const r = await get(port, '/');
    for (const src of ['/js/app.js', '/js/repos.js', '/js/insights.js']) {
      assert.ok(r.body.includes(src), `${src} should be loaded`);
    }
    assert.ok(!r.body.includes('navigate(\'/audits\')'), 'audits nav link should be gone');
  });

  it('GET /favicon.svg returns SVG', async () => {
    const r = await get(port, '/favicon.svg');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('<svg') || r.body.includes('svg'));
  });
});
