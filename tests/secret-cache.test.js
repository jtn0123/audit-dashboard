'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collector } = require('../lib/collector');
const { loadConfig } = require('../lib/config');

test('secret alert response bodies never enter the persisted ETag cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cache-test-'));
  try {
    const cacheFile = path.join(dir, 'cache.json');
    const marker = 'fixture-only-sensitive-value';
    const config = loadConfig({ GITHUB_TOKEN: 'fixture', GH_CACHE_FILE: cacheFile, GH_AUTO_REFRESH: 'false' });
    const collector = new Collector(config, { fetchImpl: async () => ({
      status: 200, ok: true,
      headers: new Map([['content-type', 'application/json'], ['etag', 'fixture-etag']]),
      json: async () => [{ number: 1, secret: marker, secret_type: 'fixture', created_at: new Date().toISOString() }]
    }) });
    const errors = [];
    const alerts = await collector.fetchSecretScanningAlerts('me/app', errors);
    assert.equal(alerts.length, 1);
    assert.deepEqual(errors, []);
    collector.saveCache();
    assert.equal(JSON.stringify(collector.etags).includes(marker), false);
    assert.equal(fs.readFileSync(cacheFile, 'utf8').includes(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loading a legacy cache drops raw secret-scanning responses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cache-test-'));
  try {
    const cacheFile = path.join(dir, 'cache.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ repos: [], etags: {
      'GET https://api.github.com/repos/me/app/secret-scanning/alerts?state=open': { data: [{ secret: 'fixture-only-sensitive-value' }] },
      'GET https://api.github.com/user': { data: { login: 'me' } }
    } }));
    const collector = new Collector(loadConfig({ GH_CACHE_FILE: cacheFile }));
    assert.equal(Object.keys(collector.etags).length, 1);
    assert.ok(collector.etags['GET https://api.github.com/user']);
    assert.equal(fs.readFileSync(cacheFile, 'utf8').includes('fixture-only-sensitive-value'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
