'use strict';

/**
 * Minimal GitHub REST client — no dependencies, built on global fetch (Node 18+).
 *
 * Features that matter for a self-hosted poller:
 *  - ETag conditional requests, so unchanged resources cost 0 rate-limit units
 *  - Link-header pagination
 *  - Rate-limit accounting + one polite retry on secondary limits
 *  - Errors carry the HTTP status so callers can tell "disabled" (403/404) from "broken"
 */

const USER_AGENT = 'audit-dashboard (self-hosted)';

class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class GitHubClient {
  /**
   * @param {object} opts
   * @param {string} opts.token           GitHub PAT
   * @param {string} [opts.apiUrl]        API base, e.g. https://api.github.com
   * @param {object} [opts.etags]         Mutable { [key]: { etag, data } } cache, safe to persist
   * @param {function} [opts.fetchImpl]   Injectable fetch, for tests
   */
  constructor({ token, apiUrl = 'https://api.github.com', etags = {}, fetchImpl } = {}) {
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.etags = etags;
    this.fetch = fetchImpl || globalThis.fetch;
    this.rate = { limit: null, remaining: null, reset: null, usedThisRun: 0 };
  }

  _url(pathOrUrl) {
    if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
    return `${this.apiUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  }

  _noteRateLimit(headers) {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (limit != null) this.rate.limit = Number(limit);
    if (remaining != null) this.rate.remaining = Number(remaining);
    if (reset != null) this.rate.reset = new Date(Number(reset) * 1000).toISOString();
  }

  /**
   * Perform a request. Returns { status, data, headers, notModified }.
   * Never throws for `allowStatus` codes — those come back with data === null so
   * callers can treat "404 = feature not enabled" as data rather than failure.
   */
  async request(pathOrUrl, { method = 'GET', accept = 'application/vnd.github+json', useEtag = true, allowStatus = [], retryOnLimit = true, body } = {}) {
    const url = this._url(pathOrUrl);
    const key = `${method} ${url}`;
    const headers = {
      accept,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28'
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const cached = useEtag && method === 'GET' ? this.etags[key] : null;
    if (cached?.etag) headers['if-none-match'] = cached.etag;

    const res = await this.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    this.rate.usedThisRun++;
    this._noteRateLimit(res.headers);

    if (res.status === 304 && cached) {
      return { status: 200, data: cached.data, headers: res.headers, notModified: true };
    }

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      const isLimit = retryAfter > 0 || remaining === 0;
      if (isLimit && retryOnLimit) {
        const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const waitMs = retryAfter > 0
          ? retryAfter * 1000
          : Math.max(0, Math.min(60_000, resetAt - Date.now()));
        if (waitMs <= 60_000) {
          await sleep(waitMs + 500);
          return this.request(pathOrUrl, { method, accept, useEtag, allowStatus, retryOnLimit: false, body });
        }
        throw new GitHubError(`Rate limited; resets at ${new Date(resetAt).toISOString()}`, res.status, null);
      }
    }

    if (allowStatus.includes(res.status)) {
      return { status: res.status, data: null, headers: res.headers, notModified: false };
    }

    if (res.status === 204) {
      return { status: 204, data: null, headers: res.headers, notModified: false };
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.message || ''; } catch { /* body may be empty or HTML */ }
      throw new GitHubError(`${method} ${url} → ${res.status}${detail ? `: ${detail}` : ''}`, res.status, detail);
    }

    const data = await res.json();
    const etag = res.headers.get('etag');
    if (useEtag && method === 'GET' && etag) this.etags[key] = { etag, data };
    return { status: res.status, data, headers: res.headers, notModified: false };
  }

  /** GET helper that returns data, or null for the statuses in `allowStatus`. */
  async get(pathOrUrl, opts = {}) {
    const { data } = await this.request(pathOrUrl, opts);
    return data;
  }

  /** Follow Link rel="next" until exhausted or `maxPages` reached. */
  async paginate(pathOrUrl, { maxPages = 5, allowStatus = [], accept } = {}) {
    let url = pathOrUrl;
    const out = [];
    for (let page = 0; page < maxPages && url; page++) {
      const res = await this.request(url, { allowStatus, accept });
      if (res.data == null) break;
      if (Array.isArray(res.data)) out.push(...res.data);
      else return res.data;
      url = parseNextLink(res.headers.get('link'));
    }
    return out;
  }

  /** Status-only probe: returns the HTTP status without throwing on 4xx. */
  async probe(pathOrUrl) {
    const res = await this.request(pathOrUrl, { useEtag: false, allowStatus: [400, 401, 403, 404, 410, 451] });
    return res.status;
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** Keep the persisted ETag cache from growing without bound. */
function pruneEtags(etags, maxEntries = 2000) {
  const keys = Object.keys(etags);
  if (keys.length <= maxEntries) return etags;
  for (const key of keys.slice(0, keys.length - maxEntries)) delete etags[key];
  return etags;
}

module.exports = { GitHubClient, GitHubError, parseNextLink, pruneEtags };
