const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const FIXTURES = path.join(__dirname, 'fixtures');
process.env.DATA_DIR = FIXTURES;
process.env.PORT = '0';

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
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
  if (server) server.close();
});

describe('API tests', () => {
  it('GET /health returns 200 with status ok', async () => {
    const r = await getJSON(port, '/health');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(r.json, { status: 'ok' });
  });

  it('GET /api/dates returns array of date strings', async () => {
    const r = await getJSON(port, '/api/dates');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.includes('2026-01-01'));
  });

  it('GET /api/report/:date returns array of normalized reports', async () => {
    const r = await getJSON(port, '/api/report/2026-01-01');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length >= 3);
  });

  it('GET /api/report/:date/:agent returns single normalized report', async () => {
    const r = await getJSON(port, '/api/report/2026-01-01/security');
    assert.equal(r.status, 200);
    assert.equal(r.json.agent, 'security');
    assert.ok(['ok', 'warning', 'critical'].includes(r.json.status));
    assert.equal(typeof r.json.score, 'number');
  });

  it('GET /api/report/:date/:agent/md returns text content', async () => {
    const r = await get(port, '/api/report/2026-01-01/security/md');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('Security Report'));
  });

  it('GET /api/report/9999-01-01 returns 404', async () => {
    const r = await get(port, '/api/report/9999-01-01');
    assert.equal(r.status, 404);
  });

  it('GET /api/report/:date/nonexistent returns 404', async () => {
    const r = await get(port, '/api/report/2026-01-01/nonexistent');
    assert.equal(r.status, 404);
  });

  it('GET /api/trends returns object with dates and data keys', async () => {
    const r = await getJSON(port, '/api/trends');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.dates));
    assert.equal(typeof r.json.data, 'object');
  });

  it('Normalization: security report has findings array', async () => {
    const r = await getJSON(port, '/api/report/2026-01-01/security');
    assert.ok(Array.isArray(r.json.findings));
    assert.ok(r.json.findings.length > 0);
  });

  it('Normalization: infra report has numeric score', async () => {
    const r = await getJSON(port, '/api/report/2026-01-01/infra');
    assert.equal(typeof r.json.score, 'number');
  });

  it('Normalization: lighthouse handles dict-style sites', async () => {
    const r = await getJSON(port, '/api/report/2026-01-01/lighthouse');
    assert.equal(typeof r.json.sites, 'object');
    assert.ok(r.json.sites['example.com']);
  });
});

describe('Static file tests', () => {
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

  it('GET /js/app.js returns JavaScript', async () => {
    const r = await get(port, '/js/app.js');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('javascript'));
  });

  it('GET /favicon.svg returns SVG', async () => {
    const r = await get(port, '/favicon.svg');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('<svg') || r.body.includes('svg'));
  });
});
