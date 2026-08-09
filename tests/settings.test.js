// The settings surface: tokens go in, never come out. Runs the real server
// against a fake GitHub, exercising validation, persistence, hot-swap, and
// the fallback-to-env behaviour on clear.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { loadSettings, saveSettings, tokenTail, looksLikeGitHubToken } = require('../lib/settings');

// Fake fixtures shaped like real PATs so the shape-check exercises; the
// inline annotations keep the secret scanner from flagging them as leaks.
const GOOD_TOKEN = 'github_pat_11ABCDEFG0123456789abcdefg'; // gitleaks:allow
const BAD_TOKEN = 'github_pat_11REJECTED0123456789abcdef'; // gitleaks:allow

function fakeGitHub() {
  return http.createServer((req, res) => {
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization || '';
    if (req.url === '/user') {
      if (auth.includes(GOOD_TOKEN)) return send({ login: 'justin', name: 'J' });
      return send({ message: 'Bad credentials' }, 401);
    }
    if (req.url.startsWith('/user/repos')) {
      // Realistic: the LIST endpoint always withholds security_and_analysis.
      return send([{ full_name: 'justin/app', name: 'app', owner: { login: 'justin' } }]);
    }
    if (req.url === '/repos/justin/app') {
      // …the single-repo object carries it when administration read is granted.
      return send({ full_name: 'justin/app', security_and_analysis: {} });
    }
    if (req.url.startsWith('/repos/justin/app/dependabot/alerts')) return send([]);
    if (req.url.startsWith('/repos/justin/app/pulls')) return send([]);
    if (req.url.startsWith('/repos/justin/app/contents/')) return send({ message: 'Resource not accessible by personal access token' }, 403);
    if (req.url.startsWith('/repos/justin/app/actions/runs')) return send({ workflow_runs: [] });
    send({ message: 'Not Found' }, 404);
  });
}

function request(port, urlPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

const postJson = (port, urlPath, obj) =>
  request(port, urlPath, { method: 'POST', body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } });

let gh, server, port, cacheDir;

before(async () => {
  gh = fakeGitHub();
  await new Promise(r => gh.listen(0, r));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${gh.address().port}`;
  process.env.GH_CACHE_FILE = path.join(cacheDir, 'cache.json');
  process.env.GH_AUTO_REFRESH = 'false';
  process.env.DATA_DIR = path.join(__dirname, 'fixtures');
  process.env.PORT = '0';

  delete require.cache[require.resolve('../server.js')];
  const express = require('express');
  const originalListen = express.application.listen;
  await new Promise((resolve) => {
    express.application.listen = function (..._args) {
      server = originalListen.call(this, 0, () => { port = server.address().port; resolve(); });
      return server;
    };
    require('../server.js');
  });
});

after(() => {
  if (server) server.close();
  if (gh) gh.close();
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('settings helpers', () => {
  it('tokenTail exposes only the last four characters', () => {
    assert.equal(tokenTail('github_pat_abcdefgh1234'), '…1234');
    assert.equal(tokenTail(''), null);
    assert.equal(tokenTail('short'), null);
  });
  it('looksLikeGitHubToken accepts real shapes, rejects junk', () => {
    assert.ok(looksLikeGitHubToken(GOOD_TOKEN));
    assert.ok(looksLikeGitHubToken('ghp_ABCDEFGHIJKLMNOP123456')); // gitleaks:allow
    assert.ok(!looksLikeGitHubToken('hello world'));
    assert.ok(!looksLikeGitHubToken('Bearer xyz'));
  });
  it('saveSettings writes mode 600 atomically', () => {
    const f = path.join(cacheDir, 'perm-check.json');
    saveSettings(f, { githubToken: 'x' });
    const mode = fs.statSync(f).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.deepEqual(loadSettings(f), { githubToken: 'x' });
  });
});

describe('settings API', () => {
  it('starts unconfigured with no env token', async () => {
    const r = await request(port, '/api/settings');
    assert.equal(r.json.github.configured, false);
    assert.equal(r.json.github.source, null);
    assert.equal(r.json.github.envTokenPresent, false);
  });

  it('rejects non-JSON posts and junk tokens without calling GitHub', async () => {
    const raw = await request(port, '/api/settings/token', { method: 'POST', body: 'token=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(raw.status, 415);
    const junk = await postJson(port, '/api/settings/token', { token: 'not-a-token' });
    assert.equal(junk.status, 400);
    assert.match(junk.json.error, /does not look like/);
  });

  it('rejects a token GitHub rejects', async () => {
    const r = await postJson(port, '/api/settings/token', { token: BAD_TOKEN });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /401/);
  });

  it('accepts a valid token: persists 600, hot-swaps, reports masked status', async () => {
    const r = await postJson(port, '/api/settings/token', { token: GOOD_TOKEN });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.viewer.login, 'justin');

    const file = path.join(cacheDir, 'settings.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(loadSettings(file).githubToken, GOOD_TOKEN);

    const s = await request(port, '/api/settings');
    assert.equal(s.json.github.configured, true);
    assert.equal(s.json.github.source, 'settings');
    assert.equal(s.json.github.tokenTail, `…${GOOD_TOKEN.slice(-4)}`);
    // The token itself never appears in any settings response.
    assert.ok(!s.body.includes(GOOD_TOKEN));

    const gh = await request(port, '/api/gh/status');
    assert.equal(gh.json.configured, true);
  });

  it('access probe reports per-permission ok/denied for the current token', async () => {
    const r = await request(port, '/api/settings/access');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.probedRepos, ['justin/app']);
    assert.equal(r.json.access.metadata, 'ok');
    assert.equal(r.json.access.dependabot_alerts, 'ok');
    assert.equal(r.json.access.pull_requests, 'ok');
    assert.equal(r.json.access.actions, 'ok');
    assert.equal(r.json.access.administration, 'ok');
    assert.equal(r.json.access.contents, 'denied'); // fake denies contents
  });

  it('clearing falls back to the (absent) env token and disconnects', async () => {
    const r = await postJson(port, '/api/settings/token', { token: '' });
    assert.equal(r.status, 200);
    assert.equal(r.json.cleared, true);
    const s = await request(port, '/api/settings');
    assert.equal(s.json.github.configured, false);
    assert.equal(loadSettings(path.join(cacheDir, 'settings.json')).githubToken, undefined);
  });
});
