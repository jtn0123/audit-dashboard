'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function frontend() {
  const context = vm.createContext({
    document: { getElementById: () => null, addEventListener() {} },
    window: { addEventListener() {} },
    sessionStorage: { getItem: () => null }, localStorage: { getItem: () => null },
    URLSearchParams, console
  });
  for (const file of ['app.js', 'repos.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  }
  return context;
}

test('advisory copy treats HTML entities and quotes as literal data', () => {
  const context = frontend();
  const payload = 'x&quot;);globalThis.injected=true;//';
  context.advisory = { severity: 'high', package: 'pkg', summary: payload, repos: [], repoCount: 0 };
  const html = vm.runInContext('renderAdvisory(advisory)', context);
  const handler = html.match(/onclick="([^"]*)"/)[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  context.copyText = (_button, text) => { context.copied = text; };
  vm.runInContext(handler, context);
  assert.equal(context.injected, undefined);
  assert.ok(context.copied.includes(payload));
});

test('read-only frontend has no merge controls or write request', () => {
  const context = frontend();
  for (const name of ['mergeSelected', 'selectAllGreen', 'togglePrSelection', 'renderMergeBar']) {
    assert.equal(typeof context[name], 'undefined');
  }
  const { spec } = require('../lib/openapi');
  for (const route of ['advisories', 'packages', 'snapshots', 'changes']) {
    assert.ok(spec.paths[`/api/gh/${route}`].get);
  }
  assert.equal(spec.paths['/api/gh/merge'], undefined);
  assert.equal(spec.paths['/api/gh/webhook'], undefined);
});
