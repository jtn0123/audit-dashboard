#!/usr/bin/env node
'use strict';

/**
 * Patch Board MCP server — stdio transport, zero dependencies.
 *
 * A thin translator: MCP tool calls in, dashboard HTTP reads out. It holds no
 * credentials and can take no action against GitHub — the dashboard is a
 * read-only sensor/planner, and whatever agent connects here executes actions
 * with its own credentials (the queue entries carry the literal gh commands).
 *
 * The tools-only slice of MCP is four JSON-RPC methods (initialize,
 * notifications/initialized, tools/list, tools/call) over newline-delimited
 * JSON on stdin/stdout, so this implements the protocol directly rather than
 * carrying an SDK; the repo's HTTP client takes the same approach to GitHub.
 *
 * Config: PATCHBOARD_URL (default http://127.0.0.1:3002).
 */

const BASE = (process.env.PATCHBOARD_URL || 'http://127.0.0.1:3002').replace(/\/$/, '');
const VERSION = '1.0.0';

async function api(method, path, timeoutMs = 20_000) {
  const res = await fetch(`${BASE}${path}`, { method, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = { raw: body }; }
  if (!res.ok) {
    const hint = json?.hint ? ` — ${json.hint}` : '';
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${json?.error || body.slice(0, 200)}${hint}`);
  }
  return json;
}

const TOOLS = [
  {
    name: 'get_status',
    description: 'Dashboard + GitHub integration status: token state, last scan time, rate limit, data freshness, errors. Always answers, even unconfigured.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/api/gh/status')
  },
  {
    name: 'refresh_and_wait',
    description: 'Force a rescan of all repos and block until the cache is fresh. Call this before acting on the queue if get_status/list_actions reports stale data (refresh-then-read).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('POST', '/api/gh/refresh', 300_000)
  },
  {
    name: 'list_actions',
    description: 'The prioritized work queue: one entry per executable step (merge_pr, close_superseded, enable_alerts, enable_security_updates, add_dependabot_config, flag_pr), each with a verdict, why, the literal gh command to run with YOUR credentials, and a policy stamp (auto_ok | requires_human + the .patchboard-policy.yml rule that decided it). Execute only policy=auto_ok unattended. Check the stale flag before executing.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Only return actions of this type (e.g. merge_pr)' },
        repo: { type: 'string', description: 'Only return actions for this owner/repo' },
        policy: { type: 'string', enum: ['auto_ok', 'requires_human'], description: 'Only return actions with this policy stamp' }
      },
      additionalProperties: false
    },
    run: async ({ type, repo, policy } = {}) => {
      const data = await api('GET', '/api/gh/actions');
      let actions = data.actions;
      if (type) actions = actions.filter(a => a.type === type);
      if (repo) actions = actions.filter(a => a.repo === repo);
      if (policy) actions = actions.filter(a => a.policy === policy);
      return { ...data, actions, returned: actions.length, totalQueue: data.actions.length };
    }
  },
  {
    name: 'get_merge_plan',
    description: 'Conflict-aware merge ordering: per-repo "trains" built from PR file overlap (lockfiles, usually). Steps within a train are strictly sequential — each carries the full command sequence including the rebase choreography; separate trains, including across repos, run in parallel safely. Respect the policy stamps: execute only policy=auto_ok steps unattended.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/api/gh/merge-plan')
  },
  {
    name: 'get_repo_posture',
    description: 'Full security posture for repos: alerts by severity, Dependabot config state, open PRs with CI verdicts, last-scan evidence, coverage gaps, risk score. Filter with search (name substring) or fetch all, sorted by risk.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Substring match on repo name' },
        filter: { type: 'string', description: 'One of: all, attention, no-dependabot, alerts-off, vulnerable, critical, open-prs, dependabot-prs, stale, clean' }
      },
      additionalProperties: false
    },
    run: ({ search, filter } = {}) => {
      const q = new URLSearchParams();
      if (search) q.set('search', search);
      if (filter) q.set('filter', filter);
      const qs = q.toString();
      return api('GET', `/api/gh/repos${qs ? '?' + qs : ''}`);
    }
  },
  {
    name: 'list_alerts',
    description: 'Open Dependabot vulnerability alerts across all repos: package, severity, advisory, fixed version.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'critical | high | medium | low' },
        repo: { type: 'string', description: 'Only this owner/repo' }
      },
      additionalProperties: false
    },
    run: ({ severity, repo } = {}) => {
      const q = new URLSearchParams();
      if (severity) q.set('severity', severity);
      if (repo) q.set('repo', repo);
      const qs = q.toString();
      return api('GET', `/api/gh/alerts${qs ? '?' + qs : ''}`);
    }
  },
  {
    name: 'get_coverage_gaps',
    description: 'Repos with scanning gaps: no dependabot.yml, alerts disabled, security updates off, stale or never-run scans — each with what to fix.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => api('GET', '/api/gh/coverage')
  }
];

// === JSON-RPC over newline-delimited stdio ==================================

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'patch-board', version: VERSION }
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications get no response
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.run(params?.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        const unreachable = e.name === 'TimeoutError' || e.cause?.code === 'ECONNREFUSED';
        const text = unreachable
          ? `Dashboard unreachable at ${BASE} — is the container up? (${e.message})`
          : `Tool failed: ${e.message}`;
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
const inflight = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = handle(msg).catch(e => {
      if (msg.id !== undefined) replyError(msg.id, -32603, e.message);
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }
});
// Drain in-flight tool calls before exiting — a client that writes a request
// and closes stdin still deserves its response.
process.stdin.on('end', async () => {
  await Promise.allSettled([...inflight]);
  process.exit(0);
});
