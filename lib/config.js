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
    webUrl: (env.GITHUB_WEB_URL || 'https://github.com').replace(/\/$/, ''),
    owners: list(env.GH_OWNERS),
    include,
    exclude,
    includeArchived: bool(env.GH_INCLUDE_ARCHIVED, false),
    includeForks: bool(env.GH_INCLUDE_FORKS, false),
    includePrivate: bool(env.GH_INCLUDE_PRIVATE, true),
    refreshMinutes: Math.max(5, num(env.GH_REFRESH_MINUTES, 30)),
    staleDays: Math.max(1, num(env.GH_STALE_DAYS, 14)),
    concurrency: Math.min(12, Math.max(1, num(env.GH_CONCURRENCY, 6))),
    maxRepos: num(env.GH_MAX_REPOS, 300),
    cacheFile: env.GH_CACHE_FILE || path.join(__dirname, '..', '.cache', 'github.json'),
    autoRefresh: bool(env.GH_AUTO_REFRESH, true),
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
