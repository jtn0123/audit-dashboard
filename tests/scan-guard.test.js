'use strict';

// A process that dies mid-scan must not be restarted straight into another
// scan forever: that loop ran 24,802 times in 2026-09 and drained the GitHub
// rate limit for everything sharing the token.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ScanGuard, MAX_BACKOFF_MS } = require('../lib/scan-guard');
const { Collector } = require('../lib/collector');
const { loadConfig } = require('../lib/config');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scan-guard-'));
const BASE = 30 * 60_000;

function fakeResponse({ status = 200, body = {} } = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body };
}

describe('ScanGuard', () => {
  it('doubles the hold for each consecutive death mid-scan, up to a cap', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'scan-state.json');
      assert.equal(new ScanGuard(file).backoffMs(BASE), 0, 'first boot scans at once');

      const waits = [];
      for (let i = 0; i < 3; i++) {
        const guard = new ScanGuard(file);
        waits.push(guard.backoffMs(BASE));
        guard.begin(); // ...and the process dies here, never reaching end()
      }
      assert.deepEqual(waits, [0, BASE, 2 * BASE]);

      fs.writeFileSync(file, JSON.stringify({ crashes: 40, inProgress: true }));
      assert.equal(new ScanGuard(file).backoffMs(BASE), MAX_BACKOFF_MS);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a boot that was not mid-scan keeps the count without raising it', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'scan-state.json');
      new ScanGuard(file).begin();
      assert.equal(new ScanGuard(file).crashes, 1);
      // Died again while being held off (no scan running): still one strike.
      assert.equal(new ScanGuard(file).crashes, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a scan that ends, even by throwing, resets the count', () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'scan-state.json');
      new ScanGuard(file).begin();
      const guard = new ScanGuard(file);
      guard.begin();
      guard.end();
      assert.equal(fs.existsSync(file), false);
      assert.equal(new ScanGuard(file).backoffMs(BASE), 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('collector crash back-off', () => {
  function setup(dir, env = {}) {
    const calls = [];
    const fetchImpl = async url => {
      calls.push(url);
      if (url.endsWith('/user')) return fakeResponse({ body: { login: 'me' } });
      if (url.includes('/user/repos')) return fakeResponse({ body: [] });
      return fakeResponse({ status: 404, body: { message: 'Not Found' } });
    };
    const config = loadConfig({
      GITHUB_TOKEN: 'x', GH_CACHE_FILE: path.join(dir, 'github.json'), GH_HISTORY_FILE: path.join(dir, 'history.json'), ...env
    });
    return { collector: new Collector(config, { fetchImpl }), calls, marker: path.join(dir, 'scan-state.json') };
  }

  it('marks a scan in progress and clears the mark when it ends', async () => {
    const dir = tmpDir();
    try {
      const { collector, marker } = setup(dir, { GH_AUTO_REFRESH: 'false' });
      const run = collector.refresh();
      assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).inProgress, true);
      await run;
      assert.equal(fs.existsSync(marker), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('after a death mid-scan, boot makes no API calls until the hold expires', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'scan-state.json'), JSON.stringify({ crashes: 0, inProgress: true }));
      const { collector, calls } = setup(dir);
      collector.start();
      try {
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(calls, [], 'an automatic scan ran straight after a crash');
        const held = collector.getStatus().scansHeldUntil;
        assert.ok(held && Date.parse(held) > Date.now() + 25 * 60_000, `held until ${held}`);

        // A person asking for a refresh is not the loop; it runs, and a scan
        // that completes lifts the hold.
        await collector.refresh();
        assert.ok(calls.length > 0);
        assert.equal(collector.getStatus().scansHeldUntil, null);
      } finally { collector.stop(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a clean boot with no marker scans immediately', async () => {
    const dir = tmpDir();
    try {
      const { collector, calls } = setup(dir);
      collector.start();
      try {
        await collector.refreshing;
        assert.ok(calls.length > 0);
        assert.equal(collector.getStatus().scansHeldUntil, null);
      } finally { collector.stop(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('shutdown clears an in-progress mark so a redeploy is not a strike', () => {
    const dir = tmpDir();
    try {
      const { collector, marker } = setup(dir, { GH_AUTO_REFRESH: 'false' });
      collector.scanGuard.begin();
      collector.shutdown();
      assert.equal(fs.existsSync(marker), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('graceful shutdown', () => {
  it('exits 0 on SIGTERM instead of waiting to be killed', async () => {
    const dir = tmpDir();
    try {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { PATH: process.env.PATH, PORT: '0', GH_AUTO_REFRESH: 'false', GH_CACHE_FILE: path.join(dir, 'github.json'), GH_HISTORY_FILE: path.join(dir, 'history.json') },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      await new Promise((resolve, reject) => {
        child.stdout.on('data', d => { if (String(d).includes('Audit dashboard on port')) resolve(); });
        child.once('exit', () => reject(new Error('server exited before listening')));
      });
      child.kill('SIGTERM');
      const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const result = await exited;
      clearTimeout(killer);
      assert.deepEqual(result, { code: 0, signal: null });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
