// Exercises the /api/gh/* endpoints against a real (fake) GitHub over HTTP,
// covering the configured path that tests/test.js deliberately leaves unset.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const DAY = 86_400_000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();

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
      if (/^\/pulls\/\d+\/files/.test(rest)) {
        return send([{ filename: 'package.json' }, { filename: 'package-lock.json' }]);
      }
      if (rest.startsWith('/pulls')) {
        if (full !== 'me/covered') return send([]);
        if (url.searchParams.get('state') === 'closed') {
          return send([
            { number: 5, title: 'build(deps): bump thing from 1.9.0 to 2.0.0', user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm_and_yarn/thing' }, merged_at: ago(4), html_url: 'https://github.com/me/covered/pull/5' },
            { number: 6, title: 'A human change that landed', user: { login: 'me' }, head: { ref: 'feat' }, merged_at: ago(6), html_url: 'https://github.com/me/covered/pull/6' },
            { number: 4, title: 'Closed without merging', user: { login: 'me' }, head: { ref: 'nope' }, merged_at: null, html_url: 'https://github.com/me/covered/pull/4' }
          ]);
        }
        return send([
          { number: 7, title: 'build(deps): bump thing from 2.0.0 to 2.0.1', user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm_and_yarn/thing', sha: 'sha7' }, base: { ref: 'main' }, created_at: ago(3), updated_at: ago(1), html_url: 'https://github.com/me/covered/pull/7', labels: [] },
          { number: 8, title: 'A human change', user: { login: 'me' }, head: { ref: 'feat', sha: 'sha8' }, base: { ref: 'main' }, created_at: ago(2), updated_at: ago(1), html_url: 'https://github.com/me/covered/pull/8', labels: [] }
        ]);
      }
      if (rest.startsWith('/actions/runs')) return send({ workflow_runs: [{ created_at: ago(1) }] });
      if (rest.startsWith('/code-scanning/analyses')) return send({ message: 'no analysis found' }, 404);
      if (rest.includes('/check-runs')) return send({ check_runs: [{ status: 'completed', conclusion: 'success' }] });
    }
    send({ message: 'Not Found' }, 404);
  });
}

function request(port, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
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
  process.env.GH_HISTORY_FILE = path.join(cacheDir, 'history.json');
  process.env.GH_AUTO_REFRESH = 'false';
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
  // closeAllConnections is required, not tidy-up: Node's global fetch pools
  // keep-alive sockets to the fake GitHub server, and plain close() waits on
  // them forever, so the test process never exits and `node --test` hangs.
  for (const s of [server, gh]) {
    if (!s) continue;
    s.closeAllConnections?.();
    s.close();
  }
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

  it('GET /api/gh/actions returns the work queue with the staleness contract', async () => {
    const r = await request(port, '/api/gh/actions');
    assert.equal(r.status, 200);
    assert.ok(r.json.dataAsOf, 'dataAsOf present');
    assert.equal(r.json.stale, false, 'fresh right after collection');
    assert.equal(typeof r.json.staleAfterMinutes, 'number');

    const types = r.json.actions.map(a => a.type);
    // me/covered's green patch bump #7 is mergeable; me/naked's disabled
    // alerts and missing config become executable gap actions.
    assert.ok(types.includes('merge_pr'));
    assert.ok(types.includes('enable_alerts'));
    assert.ok(types.includes('add_dependabot_config'));

    const merge = r.json.actions.find(a => a.type === 'merge_pr');
    assert.equal(merge.pr, 7);
    assert.equal(merge.verdict, 'safe_to_merge');
    assert.match(merge.command, /gh pr merge 7 --repo me\/covered --squash/);
    // Executable queue order: enable_alerts before merge_pr before config gaps.
    assert.ok(types.indexOf('enable_alerts') < types.indexOf('merge_pr'));
  });

  it('GET /api/gh/merge-plan builds trains from fetched PR file lists', async () => {
    const r = await request(port, '/api/gh/merge-plan');
    assert.equal(r.status, 200);
    assert.ok(r.json.dataAsOf);
    assert.equal(r.json.repos.length, 1);
    const [repo] = r.json.repos;
    assert.equal(repo.repo, 'me/covered');
    assert.equal(repo.trainCount, 1);
    const [step] = repo.trains[0].steps;
    assert.equal(step.pr, 7);
    assert.equal(step.afterPr, null);
    assert.equal(step.policy, 'auto_ok');
    assert.equal(repo.trains[0].filesUnknown, false);
    assert.match(step.commands.at(-1), /gh pr merge 7/);
  });

  it('GET /api/openapi.json describes every /api/gh endpoint', async () => {
    const r = await request(port, '/api/openapi.json');
    assert.equal(r.status, 200);
    assert.equal(r.json.openapi, '3.1.0');
    for (const p of ['/api/gh/status', '/api/gh/actions', '/api/gh/repos', '/api/gh/prs', '/api/gh/alerts', '/api/gh/coverage', '/api/gh/refresh', '/api/digest.md', '/healthz']) {
      assert.ok(r.json.paths[p], `spec missing ${p}`);
    }
  });

  it('GET /api/digest.md renders the populated briefing as markdown', async () => {
    const r = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/digest.md`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
      }).on('error', reject);
    });
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/markdown/);
    assert.match(r.body, /# Patch Board digest/);
    assert.match(r.body, /safe to merge/);
    assert.match(r.body, /me\/covered/);
  });

  it('GET /health includes GitHub integration state', async () => {
    const r = await request(port, '/health');
    assert.equal(r.json.github.configured, true);
    assert.equal(r.json.github.repoCount, 2);
  });
});

describe('GitHub insight endpoints (configured)', () => {
  it('GET /api/gh/posture separates enabled, disabled and unreadable settings', async () => {
    const r = await request(port, '/api/gh/posture');
    assert.equal(r.status, 200);
    const f = r.json.features;
    assert.deepEqual(f.dependabotConfig.enabled, ['me/covered']);
    assert.deepEqual(f.dependabotConfig.disabled, ['me/naked']);
    assert.deepEqual(f.dependabotAlerts.disabled, ['me/naked'], 'a 403 saying "disabled" is disabled');
    // me/naked has no security_and_analysis payload, so the flag is unreadable —
    // which must never be reported as "off".
    assert.deepEqual(f.securityUpdates.enabled, ['me/covered']);
    assert.deepEqual(f.securityUpdates.unknown, ['me/naked']);
    assert.equal(r.json.activeCount, 2);
    assert.ok(r.json.gaps.some(g => g.id === 'alerts-disabled'));
  });

  it('GET /api/gh/merges returns merged PRs only, newest first, with the bump parsed', async () => {
    const r = await request(port, '/api/gh/merges');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map(m => m.number), [5, 6], 'PR 4 was closed without merging');
    assert.equal(r.json[0].kind, 'dependabot');
    assert.equal(r.json[0].bump.package, 'thing');
    assert.equal(r.json[0].bump.to, '2.0.0');
  });

  it('GET /api/gh/merges filters by kind', async () => {
    const bots = await request(port, '/api/gh/merges?kind=dependabot');
    assert.deepEqual(bots.json.map(m => m.number), [5]);
    const humans = await request(port, '/api/gh/merges?kind=other');
    assert.deepEqual(humans.json.map(m => m.number), [6]);
  });

  it('GET /api/gh/trends counts human merges apart from dependency ones', async () => {
    const r = await request(port, '/api/gh/trends?days=30');
    assert.equal(r.status, 200);
    assert.equal(r.json.derived.totals.merges, 1, 'dependency PRs');
    assert.equal(r.json.derived.totals.otherMerges, 1, 'human PRs, counted but not conflated');
    assert.equal(r.json.derived.days.length, 30);
    // One open critical alert raised inside the window.
    assert.equal(r.json.derived.backlogChange, 1);
    assert.equal(r.json.derived.backlog.critical.at(-1), 1);
    assert.ok(r.json.mergeCoverage, 'the truncation caveat travels with the data');
    assert.deepEqual(r.json.mergeCoverage.truncatedRepos, []);
  });

  it('GET /api/gh/trends records the scan it just ran', async () => {
    const r = await request(port, '/api/gh/trends');
    assert.equal(r.json.recorded.meta.count, r.json.recorded.snapshots.length,
      'the plotted series must agree with the count reported beside it');
    assert.equal(r.json.recorded.snapshots.length, 1);
    assert.equal(r.json.recorded.snapshots[0].alerts.critical, 1);
  });

  it('GET /api/gh/history returns scans newest-first, oldest without a delta', async () => {
    const r = await request(port, '/api/gh/history');
    assert.equal(r.status, 200);
    assert.equal(r.json.snapshots.length, 1);
    assert.equal(r.json.snapshots[0].delta, null, 'nothing to compare the first scan against');
    assert.equal(r.json.snapshots[0].repoCount, 2);
  });

  it('GET /api/gh/calendar buckets activity by day', async () => {
    const r = await request(port, '/api/gh/calendar?days=30');
    assert.equal(r.status, 200);
    assert.equal(r.json.cells.length, 30);
    const totals = r.json.cells.reduce((acc, c) => ({
      raised: acc.raised + c.raised, merges: acc.merges + c.merges, other: acc.other + c.otherMerges
    }), { raised: 0, merges: 0, other: 0 });
    assert.equal(totals.raised, 1);
    assert.equal(totals.merges, 1);
    assert.equal(totals.other, 1);
    const day = r.json.cells.find(c => c.raised);
    assert.equal(day.critical, 1);
    assert.equal(day.alerts[0].package, 'thing');
  });
});
