'use strict';

/**
 * Hand-written OpenAPI 3.1 description of the HTTP surface. Deliberately loose
 * on response schemas (descriptions over strict typing) — the goal is that an
 * agent or generator can discover every endpoint and its parameters without
 * reading source. Served at /api/openapi.json.
 */

const pkg = require('../package.json');

function jsonResponse(description) {
  return {
    200: { description, content: { 'application/json': { schema: { type: 'object' } } } }
  };
}

const NOT_CONFIGURED = {
  503: { description: 'GitHub integration not configured (GITHUB_TOKEN unset)' }
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Patch Board API',
    version: pkg.version,
    description: 'Read-only patch-posture dashboard. The service never writes to GitHub; /api/gh/actions emits commands for agents to run with their own credentials. See /llms.txt for the agent contract and staleness rules.'
  },
  paths: {
    '/healthz': { get: { summary: 'Liveness probe (no I/O)', responses: jsonResponse('{"status":"ok"}') } },
    '/health': { get: { summary: 'Health, version, audit summary, GitHub integration state', responses: jsonResponse('Health document') } },
    '/api/gh/status': { get: { summary: 'Integration status: token state, last scan, rate limit, freshness. Always answers.', responses: jsonResponse('Status with freshness {dataAsOf, dataAgeMinutes, stale, staleAfterMinutes}') } },
    '/api/gh/actions': {
      get: {
        summary: 'Prioritized agent work queue',
        description: 'One entry per executable step: {type: merge_pr|close_superseded|enable_alerts|enable_security_updates|add_dependabot_config|flag_pr, repo, pr?, verdict, why, command, preconditions?, risk, policy: auto_ok|requires_human, policyRule}. Policy stamps come from .patchboard-policy.yml (envelope carries policySource); agents execute only auto_ok unattended. Freshness fields ride on the envelope; when stale=true, POST /api/gh/refresh first.',
        responses: { ...jsonResponse('{dataAsOf, dataAgeMinutes, stale, staleAfterMinutes, actions:[…]}'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/merge-plan': {
      get: {
        summary: 'Conflict-aware merge ordering',
        description: 'Per-repo trains built from PR file overlap: {repos:[{repo, trainCount, trains:[{sharedFiles, filesUnknown, steps:[{seq, pr, afterPr, policy, policyRule, why, commands}]}]}]}. Steps within a train are strictly sequential with rebase choreography in the commands; separate trains run in parallel. PRs with unfetchable file lists are serialized conservatively.',
        responses: { ...jsonResponse('Freshness envelope + trains'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/overview': { get: { summary: 'Cross-repo rollup + coverage gaps', responses: { ...jsonResponse('{status, summary, gaps}'), ...NOT_CONFIGURED } } },
    '/api/gh/repos': {
      get: {
        summary: 'Full posture per repo',
        parameters: [
          { name: 'filter', in: 'query', schema: { type: 'string', enum: ['all', 'attention', 'no-dependabot', 'alerts-off', 'vulnerable', 'critical', 'open-prs', 'dependabot-prs', 'stale', 'clean'] } },
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Substring match on repo name' },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['risk', 'name', 'alerts', 'prs', 'scan', 'pushed'] } }
        ],
        responses: { ...jsonResponse('Array of repo posture records (alerts, PRs with CI rollups, gaps, risk 0–100)'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/prs': {
      get: {
        summary: 'Every open PR across repos',
        parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: ['dependabot', 'other', 'all'] } }],
        responses: { ...jsonResponse('Array of PRs with checks rollup and age'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/alerts': {
      get: {
        summary: 'Open Dependabot vulnerability alerts',
        parameters: [
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] } },
          { name: 'repo', in: 'query', schema: { type: 'string' }, description: 'owner/repo' }
        ],
        responses: { ...jsonResponse('Array of alerts with package, advisory, fixed version'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/coverage': { get: { summary: 'Repos with scanning gaps and fixes', responses: { ...jsonResponse('Array of gap records'), ...NOT_CONFIGURED } } },
    '/api/gh/refresh': { post: { summary: 'Force a rescan; blocks until the cache is fresh (refresh-then-read)', responses: { ...jsonResponse('{ok, status}'), ...NOT_CONFIGURED, 502: { description: 'Refresh failed (GitHub error)' } } } },
    '/api/settings': { get: { summary: 'Runtime settings status — token source and masked tail only; secrets are never returned', responses: jsonResponse('{github: {configured, source: settings|env|null, tokenTail, envTokenPresent, viewer}}') } },
    '/api/settings/token': { post: { summary: 'Set (or clear, with empty string) the GitHub token — validated against GitHub, persisted mode-600 on the cache volume, hot-swapped without restart', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } } }, responses: { ...jsonResponse('{ok, viewer?|cleared, source}'), 400: { description: 'Malformed or GitHub-rejected token' }, 415: { description: 'Body must be application/json' } } } },
    '/api/settings/access': { get: { summary: 'Live probe of what the current token can see — {access: {metadata|dependabot_alerts|pull_requests|contents|actions|administration|code_scanning: ok|denied|unknown}}', responses: { ...jsonResponse('Per-permission probe results'), ...NOT_CONFIGURED } } },
    '/api/digest.md': { get: { summary: 'Markdown morning briefing of posture + work queue', responses: { 200: { description: 'Markdown', content: { 'text/markdown': { schema: { type: 'string' } } } } } } },
    '/api/openapi.json': { get: { summary: 'This document', responses: jsonResponse('OpenAPI 3.1 spec') } },
    '/api/gh/posture': {
      get: {
        summary: 'Cross-repo security posture: which scanning features are on, off, or invisible to this token',
        responses: { ...jsonResponse('{features, gaps, repos} — enabled/disabled/unknown are distinct'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/merges': {
      get: {
        summary: 'Recently merged pull requests — what actually got patched',
        parameters: [
          { name: 'days', in: 'query', schema: { type: 'integer' } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['dependabot', 'other', 'all'] } }
        ],
        responses: { ...jsonResponse('Array of merges with repo, author, bump and mergedAt'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/trends': {
      get: {
        summary: 'Daily series. `recorded` is the local snapshot history (starts when this dashboard first ran); `derived` is reconstructed from the dates on currently-open alerts and PRs and is a FLOOR for past days — anything already fixed left no trace',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 90 } }],
        responses: { ...jsonResponse('{recorded: {meta, snapshots}, derived: {days, backlog, raised, merges, totals}}'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/history': {
      get: {
        summary: 'Recorded scan snapshots, newest first, each with its delta from the scan before it',
        parameters: [
          { name: 'days', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }
        ],
        responses: { ...jsonResponse('{meta, snapshots: [{at, alerts, coverage, prs, delta}]}'), ...NOT_CONFIGURED }
      }
    },
    '/api/gh/calendar': {
      get: {
        summary: 'Per-day activity cells (alerts raised, PRs opened, updates merged) for the heatmap',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 90 } }],
        responses: { ...jsonResponse('{days, cells: [{date, raised, merges, prsOpened, alerts, prs, mergeList}]}'), ...NOT_CONFIGURED }
      }
    }
  }
};

module.exports = { spec };
