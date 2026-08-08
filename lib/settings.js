'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Runtime settings the UI can change — today, just the GitHub token.
 *
 * Persisted next to the collector cache (the one writable mount under the
 * read-only rootfs), mode 600, atomic rename. The settings token outranks the
 * GITHUB_TOKEN env var so the UI is authoritative once used; clearing it falls
 * back to the env value. The file never leaves the box and no API endpoint
 * ever returns its contents — see /api/settings, which reports only
 * source + last four characters.
 */

function settingsFileFor(config) {
  return path.join(path.dirname(config.cacheFile), 'settings.json');
}

function loadSettings(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Last four characters, for "which token is this" display without exposure. */
function tokenTail(token) {
  return token && token.length >= 8 ? `…${token.slice(-4)}` : null;
}

/** Loose shape check: GitHub token prefixes, no whitespace, sane length. */
function looksLikeGitHubToken(token) {
  return /^(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})$/.test(token);
}

module.exports = { settingsFileFor, loadSettings, saveSettings, tokenTail, looksLikeGitHubToken };
