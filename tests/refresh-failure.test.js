'use strict';

// A scan that throws outright (expired token) used to leave no trace: state
// is only written on success, so status kept reporting the last good run with
// errors: [] while the board went stale. In 2026-11 that hid an expired token
// for a day. These tests pin the failure to every surface a person or agent
// reads: status, the digest and the patch board banner.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { Collector } = require('../lib/collector');
const { loadConfig } = require('../lib/config');
const { buildDigest } = require('../lib/digest');

function fakeResponse({ status = 200, body = {} } = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body };
}

function setup(dir) {
  const github = { tokenValid: false };
  let clock = Date.parse('2026-11-06T20:38:00Z');
  const fetchImpl = async url => {
    if (!github.tokenValid) return fakeResponse({ status: 401, body: { message: 'Bad credentials' } });
    if (url.endsWith('/user')) return fakeResponse({ body: { login: 'me' } });
    if (url.includes('/user/repos')) return fakeResponse({ body: [] });
    return fakeResponse({ status: 404, body: { message: 'Not Found' } });
  };
  const config = loadConfig({
    GITHUB_TOKEN: 'x', GH_AUTO_REFRESH: 'false',
    GH_CACHE_FILE: path.join(dir, 'github.json'), GH_HISTORY_FILE: path.join(dir, 'history.json')
  });
  const collector = new Collector(config, { fetchImpl, now: () => clock });
  return { collector, github, advance: ms => { clock += ms; } };
}

describe('scan failures are visible', () => {
  it('records a failing streak in status and clears it on the next good scan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-failure-'));
    try {
      const { collector, github, advance } = setup(dir);
      assert.equal(collector.getStatus().lastRefreshError, null);

      await assert.rejects(collector.refresh(), /401/);
      const first = collector.getStatus().lastRefreshError;
      assert.match(first.message, /token rejected \(401\)/);
      assert.equal(first.count, 1);
      assert.equal(first.since, first.at);

      advance(30 * 60_000);
      await assert.rejects(collector.refresh(), /401/);
      const second = collector.getStatus().lastRefreshError;
      assert.equal(second.count, 2);
      assert.equal(second.since, first.since, 'the streak keeps its start');
      assert.notEqual(second.at, first.at);

      github.tokenValid = true;
      await collector.refresh();
      assert.equal(collector.getStatus().lastRefreshError, null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('the digest leads with the failure', () => {
    const md = buildDigest({
      status: {
        configured: true, fetchedAt: '2026-11-06T20:38:31Z',
        lastRefreshError: { message: 'GitHub token rejected (401). Check GITHUB_TOKEN.', at: '2026-11-08T01:00:00Z', since: '2026-11-06T21:08:00Z', count: 57 }
      },
      summary: null,
      actions: { dataAsOf: '2026-11-06T20:38:31Z', stale: true, actions: [] }
    });
    assert.match(md, /\*\*Scans are failing\*\* since 2026-11-06T21:08:00Z \(57 attempts\): GitHub token rejected \(401\)/);

    const healthy = buildDigest({ status: { configured: true, lastRefreshError: null }, summary: null, actions: null });
    assert.doesNotMatch(healthy, /Scans are failing/);
  });

  it('the patch board banner escapes the message and links to settings for token errors', () => {
    const context = vm.createContext({
      document: { getElementById: () => null, addEventListener() {} },
      window: { addEventListener() {} },
      sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null },
      URLSearchParams, console
    });
    for (const file of ['app.js', 'repos.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
    }

    context.status = { fetchedAt: '2026-11-06T20:38:31Z', lastRefreshError: null };
    assert.equal(vm.runInContext('renderScanFailureBanner(status)', context), '');

    context.status.lastRefreshError = { message: 'GitHub token rejected (401). <img src=x onerror=alert(1)>', at: 'x', since: '2026-11-06T21:08:00Z', count: 3 };
    const html = vm.runInContext('renderScanFailureBanner(status)', context);
    assert.match(html, /Scans are failing/);
    assert.match(html, /3 attempts/);
    assert.match(html, /href="#\/settings"/);
    assert.doesNotMatch(html, /<img/);

    context.status.lastRefreshError = { message: 'getaddrinfo ENOTFOUND api.github.com', at: 'x', since: 'x', count: 1 };
    const network = vm.runInContext('renderScanFailureBanner(status)', context);
    assert.match(network, /1 attempt\b/);
    assert.doesNotMatch(network, /#\/settings/, 'a network error is not a token problem');
  });
});
