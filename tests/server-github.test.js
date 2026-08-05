// Exercises the /api/gh/* endpoints against a real (fake) GitHub over HTTP,
// covering the configured path that tests/test.js deliberately leaves unset.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const crypto = require('node:crypto');

const DAY = 86_400_000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();
// Generated per run rather than written down: the test only needs the server
// and the signing helper to agree, and a literal here is indistinguishable
// from a checked-in credential to a secret scanner.
const WEBHOOK_SECRET = crypto.randomBytes(16).toString('hex');
const sign = body => `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

const REPOS = [
  {
    name: 'covered', full_name: 'me/covered', owner: { login: 'me' },
    html_url: 'https://github.com/me/covered', default_branch: 'main', language: 'JavaScript',
    pushed_at: ago(1), private: false,
    security_and_analysis: { dependabot_security_updates: { status: 'enabled' } }
  },
  {
    name: 'naked', full_name: 'me/naked', owner: { login: 'me' },
    html_url: 'https://github.com/me/naked', default_branch: 'main', language: 'Python',
    pushed_at: ago(30), private: true, security_and_analysis: {}
  }
];

function fakeGitHubServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://gh');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900' });
      res.end(JSON.stringify(body));
    };
    const p = url.pathname;
    if (p === '/user') return send({ login: 'me', name: 'Me' });
    if (p === '/user/repos') return send(REPOS);

    const m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (m) {
      const [, full, rest = ''] = m;
      if (!rest) return send(REPOS.find(r => r.full_name === full) || {});
      if (rest.startsWith('/contents/')) {
        if (full === 'me/covered' && rest.endsWith('dependabot.yml')) {
          const yaml = 'version: 2\nupdates:\n  - package-ecosystem: "npm"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n';
          return send({ content: Buffer.from(yaml).toString('base64'), encoding: 'base64' });
        }
        return send({ message: 'Not Found' }, 404);
      }
      if (rest.startsWith('/dependabot/alerts')) {
        if (full === 'me/naked') return send({ message: 'Dependabot alerts are disabled for this repository.' }, 403);
        return send([{
          number: 1,
          html_url: 'https://github.com/me/covered/security/dependabot/1',
          security_advisory: { summary: 'RCE in thing', ghsa_id: 'GHSA-x' },
          security_vulnerability: { severity: 'critical', package: { name: 'thing', ecosystem: 'npm' }, first_patched_version: { identifier: '2.0.1' } },
          created_at: ago(5), updated_at: ago(1)
        }]);
      }
      if (rest.startsWith('/pulls')) {
        if (full !== 'me/covered') return send([]);
        return send([
          { number: 7, title: 'build(deps): bump thing from 2.0.0 to 2.0.1', user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm_and_yarn/thing', sha: 'sha7' }, base: { ref: 'main' }, created_at: ago(3), updated_at: ago(1), html_url: 'https://github.com/me/covered/pull/7', labels: [] },
          { number: 8, title: 'A human change', user: { login: 'me' }, head: { ref: 'feat', sha: 'sha8' }, base: { ref: 'main' }, created_at: ago(2), updated_at: ago(1), html_url: 'https://github.com/me/covered/pull/8', labels: [] }
        ]);
      }
      if (rest.startsWith('/actions/runs')) return send({ workflow_runs: [{ created_at: ago(1) }] });
      if (rest.startsWith('/code-scanning/analyses')) return send({ message: 'no analysis found' }, 404);
      if (rest.startsWith('/code-scanning/alerts')) return send([]);
      if (rest.startsWith('/secret-scanning/alerts')) return send([]);
      if (rest.startsWith('/dependency-graph/sbom')) {
        return send({
          sbom: {
            packages: [
              { name: `com.github.${full}`, versionInfo: '1' },
              { name: 'npm:thing', versionInfo: '2.0.0' },
              { name: 'npm:shared', versionInfo: '1.0.0' }
            ]
          }
        });
      }
      if (rest.includes('/check-runs')) return send({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
    }
    send({ message: 'Not Found' }, 404);
  });
}

function request(port, urlPath, method = 'GET', { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const options = {
      method,
      headers: {
        ...(payload == null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers
      }
    };
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, options, (res) => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

let gh, server, port, cacheDir;

before(async () => {
  gh = fakeGitHubServer();
  await new Promise(resolve => gh.listen(0, resolve));

  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghsrv-'));
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_API_URL = `http://127.0.0.1:${gh.address().port}`;
  process.env.GH_CACHE_FILE = path.join(cacheDir, 'cache.json');
  process.env.GH_HISTORY_FILE = path.join(cacheDir, 'history.jsonl');
  process.env.GH_AUTO_REFRESH = 'false';
  process.env.GH_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.DATA_DIR = path.join(__dirname, 'fixtures');
  process.env.PORT = '0';

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

  // Populate the cache the read endpoints serve from
  const refreshed = await request(port, '/api/gh/refresh', 'POST');
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.json));
});

after(() => {
  if (server) server.close();
  if (gh) gh.close();
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('GitHub API tests (configured)', () => {
  it('GET /api/gh/status reports a completed scan', async () => {
    const r = await request(port, '/api/gh/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.equal(r.json.repoCount, 2);
    assert.equal(r.json.viewer.login, 'me');
    assert.ok(r.json.fetchedAt);
  });

  it('GET /api/gh/overview rolls coverage up across repos', async () => {
    const r = await request(port, '/api/gh/overview');
    assert.equal(r.status, 200);
    assert.equal(r.json.summary.activeCount, 2);
    assert.equal(r.json.summary.coverage.percent, 50);
    assert.deepEqual(r.json.summary.coverage.noConfig, ['me/naked']);
    assert.equal(r.json.summary.alerts.critical, 1);
    assert.ok(r.json.gaps.length);
  });

  it('GET /api/gh/repos sorts by risk and supports filters', async () => {
    const all = await request(port, '/api/gh/repos');
    assert.equal(all.json.length, 2);
    assert.ok(all.json[0].risk >= all.json[1].risk);

    const missing = await request(port, '/api/gh/repos?filter=no-dependabot');
    assert.deepEqual(missing.json.map(r => r.fullName), ['me/naked']);

    const byName = await request(port, '/api/gh/repos?sort=name');
    assert.deepEqual(byName.json.map(r => r.fullName), ['me/covered', 'me/naked']);

    const searched = await request(port, '/api/gh/repos?search=covered');
    assert.deepEqual(searched.json.map(r => r.fullName), ['me/covered']);
  });

  it('GET /api/gh/prs splits bot updates from human PRs', async () => {
    const all = await request(port, '/api/gh/prs');
    assert.equal(all.json.length, 2);
    assert.ok(all.json.every(pr => pr.repo === 'me/covered'));

    const bots = await request(port, '/api/gh/prs?kind=dependabot');
    assert.deepEqual(bots.json.map(pr => pr.number), [7]);
    assert.equal(bots.json[0].checks.state, 'passing');

    const humans = await request(port, '/api/gh/prs?kind=other');
    assert.deepEqual(humans.json.map(pr => pr.number), [8]);
  });

  it('GET /api/gh/alerts returns advisories with fix versions', async () => {
    const r = await request(port, '/api/gh/alerts');
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].severity, 'critical');
    assert.equal(r.json[0].patchedVersion, '2.0.1');
    assert.equal(r.json[0].repo, 'me/covered');

    const none = await request(port, '/api/gh/alerts?severity=low');
    assert.equal(none.json.length, 0);
  });

  it('GET /api/gh/coverage lists only repos with gaps', async () => {
    const r = await request(port, '/api/gh/coverage');
    assert.ok(r.json.some(g => g.fullName === 'me/naked'));
    assert.ok(r.json.every(g => g.gaps.length > 0));
  });

  it('GET /health includes GitHub integration state', async () => {
    const r = await request(port, '/health');
    assert.equal(r.json.github.configured, true);
    assert.equal(r.json.github.repoCount, 2);
  });

  it('GET /api/gh/advisories pivots alerts to one row per advisory', async () => {
    const r = await request(port, '/api/gh/advisories');
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].ghsaId, 'GHSA-x');
    assert.equal(r.json[0].repoCount, 1);
    assert.deepEqual(r.json[0].repos.map(x => x.repo), ['me/covered']);

    assert.equal((await request(port, '/api/gh/advisories?severity=low')).json.length, 0);
    assert.equal((await request(port, '/api/gh/advisories?minRepos=2')).json.length, 0);
  });

  it('GET /api/gh/packages searches the dependency graph across repos', async () => {
    const r = await request(port, '/api/gh/packages?q=shared');
    assert.equal(r.status, 200);
    assert.equal(r.json.indexed, true);
    assert.equal(r.json.results.length, 1);
    // Both repos report the package, so both should be listed.
    assert.deepEqual(r.json.results[0].repos.map(x => x.repo).sort(), ['me/covered', 'me/naked']);
    // The SPDX entry describing the repo itself is not a dependency.
    assert.equal(r.json.results.some(p => p.name.startsWith('com.github.')), false);

    const empty = await request(port, '/api/gh/packages');
    assert.deepEqual(empty.json.results, []);
    assert.ok(empty.json.count >= 2);
  });

  it('GET /api/gh/history returns a snapshot per scan', async () => {
    const r = await request(port, '/api/gh/history');
    assert.equal(r.status, 200);
    assert.ok(r.json.length >= 1);
    const latest = r.json[r.json.length - 1];
    assert.equal(latest.repos, 2);
    assert.equal(latest.critical, 1);
    assert.equal(latest.byRepo['me/covered'], 1);
  });

  it('GET /api/gh/changes needs a timestamp and reports nothing on a single scan', async () => {
    const missing = await request(port, '/api/gh/changes');
    assert.equal(missing.status, 400);

    const r = await request(port, `/api/gh/changes?since=${encodeURIComponent(ago(1))}`);
    assert.equal(r.status, 200);
    // One scan means no baseline to compare against yet.
    assert.equal(r.json.changes, null);
  });

  it('POST /api/gh/merge refuses to write unless writes are enabled', async () => {
    const r = await request(port, '/api/gh/merge', 'POST', { body: { repo: 'me/covered', number: 7 } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /GH_ALLOW_WRITES/);

    // Still open — nothing was merged.
    const prs = await request(port, '/api/gh/prs?kind=dependabot');
    assert.deepEqual(prs.json.map(pr => pr.number), [7]);
  });

  it('POST /api/gh/webhook rejects anything it cannot verify', async () => {
    const body = JSON.stringify({ repository: { full_name: 'me/covered' }, action: 'created' });
    const unsigned = await request(port, '/api/gh/webhook', 'POST', {
      body, headers: { 'x-github-event': 'dependabot_alert' }
    });
    assert.equal(unsigned.status, 401);

    const wrong = await request(port, '/api/gh/webhook', 'POST', {
      body, headers: { 'x-github-event': 'dependabot_alert', 'x-hub-signature-256': sign('something else') }
    });
    assert.equal(wrong.status, 401);
  });

  it('POST /api/gh/webhook re-collects the repo a signed event names', async () => {
    const body = JSON.stringify({ repository: { full_name: 'me/covered' }, action: 'created' });
    const r = await request(port, '/api/gh/webhook', 'POST', {
      body, headers: { 'x-github-event': 'dependabot_alert', 'x-hub-signature-256': sign(body) }
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.action, 'recollect');
    assert.equal(r.json.repo, 'me/covered');

    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const pinged = await request(port, '/api/gh/webhook', 'POST', {
      body: ping, headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sign(ping) }
    });
    assert.equal(pinged.json.action, 'ack');

    const starred = JSON.stringify({ repository: { full_name: 'me/covered' } });
    const ignored = await request(port, '/api/gh/webhook', 'POST', {
      body: starred, headers: { 'x-github-event': 'star', 'x-hub-signature-256': sign(starred) }
    });
    assert.equal(ignored.json.action, 'ignore');
  });
});
