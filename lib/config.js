'use strict';

const path = require('path');

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function num(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  if (!value) return [];
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

// Minimal glob: supports `*` wildcards, matched against `owner/repo` and `repo`.
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesAny(patterns, fullName) {
  if (!patterns.length) return false;
  const shortName = fullName.includes('/') ? fullName.split('/')[1] : fullName;
  return patterns.some(p => {
    const re = globToRegExp(p);
    return re.test(fullName) || re.test(shortName);
  });
}

function loadConfig(env = process.env) {
  const include = list(env.GH_REPOS_INCLUDE);
  const exclude = list(env.GH_REPOS_EXCLUDE);
  return {
    token: (env.GITHUB_TOKEN || env.GH_TOKEN || '').trim(),
    apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''),
    owners: list(env.GH_OWNERS),
    include,
    exclude,
    includeArchived: bool(env.GH_INCLUDE_ARCHIVED, false),
    includeForks: bool(env.GH_INCLUDE_FORKS, false),
    includePrivate: bool(env.GH_INCLUDE_PRIVATE, true),
    refreshMinutes: Math.max(5, num(env.GH_REFRESH_MINUTES, 30)),
    staleDays: Math.max(1, num(env.GH_STALE_DAYS, 14)),
    concurrency: Math.min(12, Math.max(1, num(env.GH_CONCURRENCY, 6))),
    maxRepos: Math.max(1, num(env.GH_MAX_REPOS, 300)),
    cacheFile: env.GH_CACHE_FILE || path.join(__dirname, '..', '.cache', 'github.json'),
    autoRefresh: bool(env.GH_AUTO_REFRESH, true),

    // How long an open alert of each severity may sit before it counts as a
    // breach. These are policy, not physics — tune them to your own tolerance.
    sla: {
      critical: Math.max(0, num(env.GH_SLA_CRITICAL_DAYS, 7)),
      high: Math.max(0, num(env.GH_SLA_HIGH_DAYS, 30)),
      medium: Math.max(0, num(env.GH_SLA_MEDIUM_DAYS, 90)),
      low: Math.max(0, num(env.GH_SLA_LOW_DAYS, 180))
    },

    // Optional collectors, each costing roughly one extra request per repo
    collectCodeScanning: bool(env.GH_COLLECT_CODE_SCANNING, true),
    collectSecretScanning: bool(env.GH_COLLECT_SECRET_SCANNING, true),
    collectCi: bool(env.GH_COLLECT_CI, true),
    collectDockerfiles: bool(env.GH_COLLECT_DOCKERFILES, true),
    collectDismissed: bool(env.GH_COLLECT_DISMISSED, true),
    // The SBOM is the one heavyweight fetch: a full dependency list per repo.
    collectSbom: bool(env.GH_COLLECT_SBOM, true),
    maxPackagesPerRepo: Math.max(1, num(env.GH_MAX_PACKAGES_PER_REPO, 3000)),

    historyFile: env.GH_HISTORY_FILE || path.join(__dirname, '..', '.cache', 'history.jsonl'),
    historyDays: Math.max(1, num(env.GH_HISTORY_DAYS, 180)),

    // Writes are opt-in: everything else in this app is read-only, and merging
    // needs a token with push access, which is a different security posture.
    allowWrites: bool(env.GH_ALLOW_WRITES, false),
    webhookSecret: (env.GH_WEBHOOK_SECRET || '').trim(),

    get enabled() { return Boolean(this.token); }
  };
}

// A repo passes when: include list is empty or matches, and exclude never matches.
function repoSelected(repo, config) {
  const fullName = repo.full_name || repo.fullName || '';
  if (config.exclude.length && matchesAny(config.exclude, fullName)) return false;
  if (config.include.length && !matchesAny(config.include, fullName)) return false;
  if (!config.includeArchived && repo.archived) return false;
  if (!config.includeForks && repo.fork) return false;
  if (!config.includePrivate && repo.private) return false;
  return true;
}

module.exports = { loadConfig, repoSelected, matchesAny, globToRegExp, bool, num, list };
