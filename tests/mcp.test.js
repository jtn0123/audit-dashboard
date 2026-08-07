// Drives mcp/server.js as a real child process over stdio: full MCP handshake,
// tool listing, tool calls against a stub dashboard, and the unreachable case.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ACTIONS = {
  dataAsOf: '2026-08-07T00:00:00.000Z', dataAgeMinutes: 1, staleAfterMinutes: 60, stale: false,
  actions: [
    { type: 'merge_pr', repo: 'me/app', pr: 7, verdict: 'safe_to_merge', why: 'green CI, patch bump', command: 'gh pr merge 7 --repo me/app --squash --delete-branch', preconditions: ['x'], risk: 40 },
    { type: 'flag_pr', repo: 'me/app', pr: 8, verdict: 'breaking_major', why: 'major bump', command: 'gh pr view 8 --repo me/app', risk: 40 },
    { type: 'enable_alerts', repo: 'me/other', verdict: 'gap', why: 'alerts off', command: 'gh api -X PUT /repos/me/other/vulnerability-alerts', risk: 90 }
  ]
};

function stubDashboard() {
  return http.createServer((req, res) => {
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/gh/status') return send({ configured: true, repoCount: 2, freshness: { stale: false } });
    if (req.url.startsWith('/api/gh/actions')) return send(ACTIONS);
    if (req.url.startsWith('/api/gh/repos')) return send([{ fullName: 'me/app', risk: 40 }]);
    if (req.url === '/api/gh/refresh' && req.method === 'POST') return send({ ok: true });
    send({ error: 'GitHub integration not configured', hint: 'Set GITHUB_TOKEN.' }, 503);
  });
}

// Minimal MCP client over the child's stdio.
class Client {
  constructor(env) {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit']
    });
    this.pending = new Map();
    this.nextId = 1;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
      this.pending.set(id, msg => { clearTimeout(t); resolve(msg); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  close() { this.child.stdin.end(); this.child.kill(); }
}

let stub, stubPort, client;

before(async () => {
  stub = stubDashboard();
  await new Promise(r => stub.listen(0, r));
  stubPort = stub.address().port;
  client = new Client({ PATCHBOARD_URL: `http://127.0.0.1:${stubPort}` });
  const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'patch-board');
  client.notify('notifications/initialized');
});

after(() => {
  if (client) client.close();
  if (stub) stub.close();
});

describe('MCP server', () => {
  it('lists tools with JSON Schema inputs', async () => {
    const r = await client.request('tools/list');
    const names = r.result.tools.map(t => t.name);
    for (const expected of ['get_status', 'refresh_and_wait', 'list_actions', 'get_merge_plan', 'get_repo_posture', 'list_alerts', 'get_coverage_gaps']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    assert.ok(r.result.tools.every(t => t.inputSchema.type === 'object'));
  });

  it('list_actions returns the queue and supports type filtering', async () => {
    const all = await client.request('tools/call', { name: 'list_actions', arguments: {} });
    const parsed = JSON.parse(all.result.content[0].text);
    assert.equal(parsed.totalQueue, 3);
    assert.equal(parsed.stale, false);

    const merges = await client.request('tools/call', { name: 'list_actions', arguments: { type: 'merge_pr' } });
    const m = JSON.parse(merges.result.content[0].text);
    assert.equal(m.returned, 1);
    assert.equal(m.actions[0].pr, 7);
    assert.match(m.actions[0].command, /gh pr merge 7/);
  });

  it('get_merge_plan carries only merge work plus the ordering caveat', async () => {
    const r = await client.request('tools/call', { name: 'get_merge_plan', arguments: {} });
    const plan = JSON.parse(r.result.content[0].text);
    assert.deepEqual(plan.steps.map(s => s.type), ['merge_pr']);
    assert.match(plan.note, /#36/);
  });

  it('surfaces API errors as tool errors, not crashes', async () => {
    const r = await client.request('tools/call', { name: 'get_coverage_gaps', arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /503/);
  });

  it('unknown tools produce a JSON-RPC error', async () => {
    const r = await client.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(r.error.code, -32602);
  });

  it('drains in-flight calls when stdin closes (one-shot piping works)', async () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.js')], {
      env: { ...process.env, PATCHBOARD_URL: `http://127.0.0.1:${stubPort}` }, stdio: ['pipe', 'pipe', 'inherit']
    });
    child.stdin.end(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } }) + '\n'
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => out += c);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('child did not exit')), 10_000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    const responses = out.trim().split('\n').map(l => JSON.parse(l));
    const status = responses.find(r => r.id === 2);
    assert.ok(status, 'response to the in-flight call arrived before exit');
    assert.match(status.result.content[0].text, /"configured": true/);
  });

  it('reports the dashboard as unreachable with a useful message', async () => {
    const lonely = new Client({ PATCHBOARD_URL: 'http://127.0.0.1:1' });
    await lonely.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const r = await lonely.request('tools/call', { name: 'get_status', arguments: {} });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /unreachable|Tool failed/);
    lonely.close();
  });
});
