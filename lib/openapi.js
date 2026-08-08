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
    '/api/digest.md': { get: { summary: 'Markdown morning briefing of posture + work queue', responses: { 200: { description: 'Markdown', content: { 'text/markdown': { schema: { type: 'string' } } } } } } },
    '/api/openapi.json': { get: { summary: 'This document', responses: jsonResponse('OpenAPI 3.1 spec') } },
    '/api/dates': { get: { summary: 'Audit subsystem: available report dates', responses: jsonResponse('Array of YYYY-MM-DD strings') } },
    '/api/summary': { get: { summary: 'Audit subsystem: latest-day summary with deltas', responses: jsonResponse('Summary or {error} when no data') } },
    '/api/report/{date}': { get: { summary: 'Audit subsystem: all agent reports for a date', parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string' } }], responses: jsonResponse('Reports') } },
    '/api/report/{date}/{agent}': { get: { summary: 'Audit subsystem: one agent report', parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string' } }, { name: 'agent', in: 'path', required: true, schema: { type: 'string' } }], responses: jsonResponse('Report') } },
    '/api/findings': { get: { summary: 'Audit subsystem: findings across all dates with status', responses: jsonResponse('Array of findings') } },
    '/api/trends': { get: { summary: 'Audit subsystem: scores over time', responses: jsonResponse('Trend series') } }
  }
};

module.exports = { spec };
