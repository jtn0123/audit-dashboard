'use strict';

const fs = require('fs');
const { matchesAny, list, bool } = require('./config');

/**
 * Agent guardrails, read from .patchboard-policy.yml. The human writes rules
 * once; the queue stamps every action `policy: auto_ok | requires_human` plus
 * the rule that decided it, and agents execute only auto_ok unattended.
 *
 * Policy is a brake, never an accelerator: it can gate an action DOWN to
 * requires_human, but nothing here promotes work past its verdict — a major
 * bump stays flagged no matter what the file says.
 *
 * The defaults below encode the verdict engine's own judgement, so a missing
 * file changes nothing.
 */

const DEFAULT_POLICY = {
  version: 1,
  auto: {
    merge_patch: true,
    merge_minor: true,
    docker_bumps: true,
    close_superseded: true,
    enable_alerts: true,
    enable_security_updates: true
  },
  neverAuto: [],   // repo globs where every action requires a human
  source: 'defaults'
};

/**
 * Parse the constrained YAML subset the policy file uses: `key: value` pairs,
 * one nesting level, booleans, comma-separated lists, comments. Same
 * no-YAML-dependency approach as the dependabot.yml reader in collector.js.
 */
function parsePolicy(text) {
  const policy = structuredClone(DEFAULT_POLICY);
  let section = null;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();

    if (!indented) {
      section = value === '' ? key : null;
      if (key === 'version' && value) policy.version = parseInt(value, 10) || 1;
      if (key === 'never_auto' && value) policy.neverAuto = list(value);
      continue;
    }
    if (section === 'auto' && key in policy.auto) {
      policy.auto[key] = bool(value, policy.auto[key]);
    }
    if (section === 'never_auto') continue; // lists are inline, not nested
  }
  return policy;
}

/** Load from disk; a missing or unreadable file means defaults, loudly labelled. */
function loadPolicy(filePath) {
  try {
    const parsed = parsePolicy(fs.readFileSync(filePath, 'utf8'));
    parsed.source = filePath;
    return parsed;
  } catch {
    return structuredClone(DEFAULT_POLICY);
  }
}

/**
 * Decide auto_ok vs requires_human for one queue action.
 * Returns { policy, policyRule } — policyRule names the deciding rule.
 */
function evaluateAction(action, policy = DEFAULT_POLICY, { ecosystem = null, bumpType = null } = {}) {
  if (policy.neverAuto.length && matchesAny(policy.neverAuto, action.repo)) {
    return { policy: 'requires_human', policyRule: 'never_auto repo match' };
  }
  switch (action.type) {
    case 'merge_pr': {
      if (ecosystem === 'docker' && !policy.auto.docker_bumps) {
        return { policy: 'requires_human', policyRule: 'auto.docker_bumps: false' };
      }
      if (bumpType === 'patch') {
        return policy.auto.merge_patch
          ? { policy: 'auto_ok', policyRule: 'auto.merge_patch' }
          : { policy: 'requires_human', policyRule: 'auto.merge_patch: false' };
      }
      if (bumpType === 'minor') {
        return policy.auto.merge_minor
          ? { policy: 'auto_ok', policyRule: 'auto.merge_minor' }
          : { policy: 'requires_human', policyRule: 'auto.merge_minor: false' };
      }
      // safe_to_merge without a classified bump type shouldn't happen; gate it.
      return { policy: 'requires_human', policyRule: 'unclassified bump' };
    }
    case 'close_superseded':
      return policy.auto.close_superseded
        ? { policy: 'auto_ok', policyRule: 'auto.close_superseded' }
        : { policy: 'requires_human', policyRule: 'auto.close_superseded: false' };
    case 'enable_alerts':
      return policy.auto.enable_alerts
        ? { policy: 'auto_ok', policyRule: 'auto.enable_alerts' }
        : { policy: 'requires_human', policyRule: 'auto.enable_alerts: false' };
    case 'enable_security_updates':
      return policy.auto.enable_security_updates
        ? { policy: 'auto_ok', policyRule: 'auto.enable_security_updates' }
        : { policy: 'requires_human', policyRule: 'auto.enable_security_updates: false' };
    default:
      // add_dependabot_config (a content decision) and every flag_pr.
      return { policy: 'requires_human', policyRule: 'not automatable' };
  }
}

module.exports = { DEFAULT_POLICY, parsePolicy, loadPolicy, evaluateAction };
