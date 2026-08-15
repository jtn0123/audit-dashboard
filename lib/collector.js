'use strict';

const fs = require('fs');
const path = require('path');

const { GitHubClient, pruneEtags } = require('./github');
const { repoSelected } = require('./config');
const { buildRepoPosture, appendCheckDerivedGaps, summarize, classifyPr, parseBumpTitle } = require('./posture');
const { buildActionQueue } = require('./verdicts');
const { loadPolicy } = require('./policy');
const { buildMergePlan } = require('./mergetrain');
const { HistoryStore } = require('./history');
const { buildTimeline, buildCalendar } = require('./timeline');

const DEPENDABOT_CONFIG_PATHS = ['.github/dependabot.yml', '.github/dependabot.yaml'];
const MAX_PR_CHECK_FETCHES = 15;
const MAX_RECENT_MERGES = 100;
const RECENT_MERGE_WINDOW_DAYS = 120;

/** Run tasks with a fixed concurrency ceiling so we stay polite to the API. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Shallow dependabot.yml reader: pulls out ecosystems, directories and schedules
 * without adding a YAML dependency. The file is a fixed, simple shape in practice.
 */
function parseDependabotConfig(text) {
  const ecosystems = [];
  const schedules = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    const eco = line.match(/package-ecosystem:\s*["']?([\w-]+)["']?/);
    if (eco) {
      current = { ecosystem: eco[1], directory: '/', interval: null };
      ecosystems.push(current);
      continue;
    }
    const dir = line.match(/directory:\s*["']?([^"'\s]+)["']?/);
    if (dir && current) current.directory = dir[1];
    const interval = line.match(/interval:\s*["']?([\w-]+)["']?/);
    if (interval) {
      if (current) current.interval = interval[1];
      if (!schedules.includes(interval[1])) schedules.push(interval[1]);
    }
  }
  return { ecosystems, schedules };
}

/** Roll a list of check runs up into one pass/fail/pending verdict. */
function rollupChecks(checkRuns = []) {
  if (!checkRuns.length) return { state: 'none', total: 0, failing: 0, pending: 0, failingNames: [] };
  let failing = 0, pending = 0, passing = 0;
  const failingNames = [];
  for (const run of checkRuns) {
    if (run.status !== 'completed') { pending++; continue; }
    if (['success', 'neutral', 'skipped'].includes(run.conclusion)) passing++;
    else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(run.conclusion)) {
      failing++;
      // Names let posture tell a config failure (Sonar token) from a code one.
      if (failingNames.length < 5 && run.name) failingNames.push(run.name);
    } else pending++;
  }
  const state = failing ? 'failing' : pending ? 'pending' : passing ? 'passing' : 'none';
  return { state, total: checkRuns.length, failing, pending, failingNames };
}

/**
 * Repo-list filters, selected by `switch` rather than by indexing a lookup
 * table. `filter` and `sort` arrive on the query string, and any keyed lookup —
 * object or Map — is a dynamic dispatch on user input; `switch` has no key to
 * poison and returns null for anything unrecognised.
 */
function repoFilter(filter, staleDays) {
  switch (filter) {
    case 'all': return () => true;
    case 'attention': return r => r.risk > 0;
    case 'no-dependabot': return r => !r.dependabot.configPresent && !r.archived;
    case 'alerts-off': return r => r.dependabot.alertsEnabled === false;
    case 'vulnerable': return r => r.alerts.counts.total > 0;
    case 'critical': return r => r.alerts.counts.critical > 0 || r.alerts.counts.high > 0;
    case 'open-prs': return r => r.prs.counts.total > 0;
    case 'dependabot-prs': return r => r.prs.counts.dependabot > 0;
    case 'stale': return r => r.lastScan.source === 'none' || (r.lastScan.ageDays != null && r.lastScan.ageDays > staleDays);
    case 'clean': return r => r.risk === 0;
    default: return null;
  }
}

/** Repo-list comparators; anything unrecognised falls back to risk order. */
function repoComparator(sort) {
  switch (sort) {
    case 'name': return (a, b) => a.fullName.localeCompare(b.fullName);
    case 'alerts': return (a, b) => b.alerts.counts.total - a.alerts.counts.total;
    case 'prs': return (a, b) => b.prs.counts.total - a.prs.counts.total;
    case 'scan': return (a, b) => (b.lastScan.ageDays ?? 1e9) - (a.lastScan.ageDays ?? 1e9);
    case 'pushed': return (a, b) => (a.pushedDaysAgo ?? 1e9) - (b.pushedDaysAgo ?? 1e9);
    default: return (a, b) => b.risk - a.risk;
  }
}

class Collector {
  constructor(config, { fetchImpl, now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.etags = {};
    this.fetchImpl = fetchImpl;
    this.client = new GitHubClient({ token: config.token, apiUrl: config.apiUrl, etags: this.etags, fetchImpl });
    this.state = {
      configured: config.enabled,
      fetchedAt: null,
      durationMs: null,
      repos: [],
      summary: null,
      errors: [],
      rate: null,
      viewer: null
    };
    this.refreshing = null;
    this.timer = null;
    // GitHub cannot answer "how many alerts were open last Tuesday", so every
    // completed scan is appended locally and the trend views read that back.
    this.history = new HistoryStore({
      file: config.historyFile,
      retentionDays: config.historyDays,
      now
    });
    this.loadCache();
  }

  // === Persistence =========================================================

  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.cacheFile, 'utf8'));
      if (raw && Array.isArray(raw.repos)) {
        this.state = { ...this.state, ...raw.state, repos: raw.repos, summary: raw.summary, fetchedAt: raw.fetchedAt };
        Object.assign(this.etags, raw.etags || {});
      }
    } catch { /* no cache yet — first run will build it */ }
  }

  saveCache() {
    try {
      fs.mkdirSync(path.dirname(this.config.cacheFile), { recursive: true });
      const payload = {
        fetchedAt: this.state.fetchedAt,
        repos: this.state.repos,
        summary: this.state.summary,
        state: { durationMs: this.state.durationMs, errors: this.state.errors, rate: this.state.rate, viewer: this.state.viewer },
        etags: pruneEtags(this.etags)
      };
      const tmp = `${this.config.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.config.cacheFile);
    } catch (e) {
      console.warn('[github] could not persist cache:', e.message);
    }
  }

  // === Scheduling ==========================================================

  /**
   * Swap the GitHub token at runtime (the settings page saves one) — new
   * client, same ETag store, and the polling loop starts or stops to match.
   */
  setToken(token) {
    this.config.token = (token || '').trim();
    this.client = new GitHubClient({ token: this.config.token, apiUrl: this.config.apiUrl, etags: this.etags, fetchImpl: this.fetchImpl });
    this.state.configured = this.config.enabled;
    if (this.config.enabled) this.start();
    else this.stop();
  }

  start() {
    if (this.timer) return;
    if (!this.config.enabled || !this.config.autoRefresh) return;
    const stale = !this.state.fetchedAt ||
      Date.now() - Date.parse(this.state.fetchedAt) > this.config.refreshMinutes * 60_000;
    if (stale) this.refresh().catch(e => console.warn('[github] initial refresh failed:', e.message));
    this.timer = setInterval(
      () => this.refresh().catch(e => console.warn('[github] refresh failed:', e.message)),
      this.config.refreshMinutes * 60_000
    );
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Refresh everything. Concurrent callers share the in-flight run. */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _refresh() {
    if (!this.config.enabled) throw new Error('GITHUB_TOKEN is not set');
    const started = Date.now();
    const errors = [];
    this.client.rate.usedThisRun = 0;

    let viewer = this.state.viewer;
    try {
      const me = await this.client.get('/user');
      viewer = { login: me.login, name: me.name || null, avatar: me.avatar_url || null };
    } catch (e) {
      errors.push({ scope: 'auth', message: e.message });
      if (e.status === 401) throw new Error('GitHub token rejected (401). Check GITHUB_TOKEN.', { cause: e });
    }

    const discovered = await this.discoverRepos(errors);
    const selected = discovered.filter(r => repoSelected(r, this.config)).slice(0, this.config.maxRepos);

    // One bad repo must not sink the whole run — every other repo's data is
    // still worth showing, and _refresh would otherwise throw before saving.
    const collected = await mapLimit(selected, this.config.concurrency, async repo => {
      try {
        return await this.collectRepo(repo);
      } catch (e) {
        errors.push({ scope: `repo:${repo.full_name || 'unknown'}`, message: e.message });
        return null;
      }
    });
    const postures = collected.filter(p => p && p.fullName);

    postures.sort((a, b) => b.risk - a.risk || a.fullName.localeCompare(b.fullName));

    this.state = {
      configured: true,
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      repos: postures,
      summary: summarize(postures, { staleDays: this.config.staleDays }),
      errors,
      rate: { ...this.client.rate },
      viewer,
      discoveredCount: discovered.length,
      skippedCount: discovered.length - selected.length
    };
    this.saveCache();
    // Recorded after the cache write so a history failure can never cost us the scan.
    try { this.history.record(this.state); } catch (e) { console.warn('[history] record failed:', e.message); }
    return this.state;
  }

  // === Fetching ============================================================

  async discoverRepos(errors) {
    const repos = [];
    const seen = new Set();
    const push = list => {
      for (const r of list || []) {
        if (r && !seen.has(r.full_name)) { seen.add(r.full_name); repos.push(r); }
      }
    };

    if (this.config.owners.length) {
      for (const owner of this.config.owners) {
        const slug = encodeURIComponent(owner);
        let fromOrg = [];
        try {
          fromOrg = await this.client.paginate(`/orgs/${slug}/repos?per_page=100&sort=pushed`, { maxPages: 5, allowStatus: [404] }) || [];
          push(fromOrg);
        } catch (e) {
          if (e.status !== 404) errors.push({ scope: `org:${owner}`, message: e.message });
        }
        // Only fall back to the user listing when the org listing found nothing;
        // an owner is one or the other, and the miss costs a request.
        if (fromOrg.length) continue;
        try {
          push(await this.client.paginate(`/users/${slug}/repos?per_page=100&sort=pushed`, { maxPages: 5, allowStatus: [404] }));
        } catch (e) {
          errors.push({ scope: `user:${owner}`, message: e.message });
        }
      }
    } else {
      try {
        push(await this.client.paginate('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', { maxPages: 5 }));
      } catch (e) {
        errors.push({ scope: 'repos', message: e.message });
      }
    }
    return repos;
  }

  async collectRepo(repo) {
    const full = repo.full_name;
    const errors = [];
    const raw = { repo, errors };

    // Repo detail — only when the listing withheld security_and_analysis (admin-only field).
    if (repo.security_and_analysis === undefined) {
      try {
        const detail = await this.client.get(`/repos/${full}`);
        if (detail) raw.repo = { ...repo, ...detail };
      } catch (e) {
        if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'repo', message: e.message });
      }
    }
    const sa = raw.repo.security_and_analysis;
    raw.securityUpdatesEnabled = sa?.dependabot_security_updates
      ? sa.dependabot_security_updates.status === 'enabled'
      : null;
    raw.secretScanning = {
      enabled: sa?.secret_scanning ? sa.secret_scanning.status === 'enabled' : null,
      pushProtection: sa?.secret_scanning_push_protection ? sa.secret_scanning_push_protection.status === 'enabled' : null
    };

    const [config, alerts, pulls, dependabotRunAt, codeScanning, recentMerges] = await Promise.all([
      this.fetchDependabotConfig(full, errors),
      this.fetchAlerts(full, raw, errors),
      this.fetchPulls(full, errors),
      this.fetchLastDependabotRun(full, errors),
      this.fetchCodeScanning(full, errors),
      this.fetchRecentMerges(full, errors)
    ]);

    raw.config = config;
    raw.alerts = alerts;
    raw.pulls = pulls;
    raw.dependabotRunAt = dependabotRunAt;
    raw.codeScanning = codeScanning;

    const posture = buildRepoPosture(raw, { staleDays: this.config.staleDays, now: this.now() });
    posture.recentMerges = recentMerges.list;
    posture.merges = { truncated: recentMerges.truncated, completeSince: recentMerges.completeSince };
    await this.attachChecks(full, posture, errors);
    appendCheckDerivedGaps(posture);
    posture.errors = errors;
    return posture;
  }

  /**
   * Recently merged pull requests — the only record GitHub keeps of what
   * actually got patched.
   *
   * A busy repo can merge more in the window than one page returns, so this
   * reports how far back the list is actually complete. Without that, a
   * truncated list reads as "we patched less back then" and the trend charts
   * draw a sampling artifact as if it were real activity.
   */
  async fetchRecentMerges(full, errors) {
    const cutoff = this.now() - RECENT_MERGE_WINDOW_DAYS * 86_400_000;
    const empty = { list: [], truncated: false, completeSince: new Date(cutoff).toISOString() };
    try {
      const data = await this.client.get(
        `/repos/${full}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
        { allowStatus: [403, 404] }
      );
      if (!Array.isArray(data)) return empty;
      const merged = data
        .filter(pr => pr.merged_at && Date.parse(pr.merged_at) >= cutoff)
        .map(pr => ({
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          author: pr.user?.login || 'unknown',
          kind: classifyPr(pr),
          mergedAt: pr.merged_at,
          bump: parseBumpTitle(pr.title)
        }))
        .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));

      // A full page back from GitHub means there may be more beyond it; the
      // list is only trustworthy as far back as its oldest surviving entry.
      const pageWasFull = data.length >= 100;
      const list = merged.slice(0, MAX_RECENT_MERGES);
      const truncated = pageWasFull || merged.length > MAX_RECENT_MERGES;
      return {
        list,
        truncated,
        completeSince: truncated && list.length
          ? list[list.length - 1].mergedAt
          : new Date(cutoff).toISOString()
      };
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'merged-prs', message: e.message });
      return empty;
    }
  }

  /**
   * How far back the merge history is trustworthy across all repos. The
   * charts are only honest as far back as the *worst* repo is complete.
   */
  mergeCoverage() {
    const active = this.state.repos.filter(r => !r.archived);
    const truncated = active.filter(r => r.merges?.truncated);
    // Compared as instants, not strings: these happen to be ISO-8601 UTC, where
    // lexicographic order matches chronological order, but that is a property of
    // the format rather than something worth depending on.
    const completeSince = truncated
      .map(r => r.merges.completeSince)
      .filter(Boolean)
      .reduce((latest, at) => (latest == null || Date.parse(at) > Date.parse(latest) ? at : latest), null);
    return {
      windowDays: RECENT_MERGE_WINDOW_DAYS,
      perRepoLimit: MAX_RECENT_MERGES,
      truncatedRepos: truncated.map(r => r.fullName),
      // Before this date, merges are undercounted for the repos listed above.
      completeSince
    };
  }

  async fetchDependabotConfig(full, errors) {
    for (const p of DEPENDABOT_CONFIG_PATHS) {
      try {
        const res = await this.client.request(`/repos/${full}/contents/${p}`, { allowStatus: [404] });
        if (res.status === 404 || !res.data) continue;
        const text = Buffer.from(res.data.content || '', res.data.encoding || 'base64').toString('utf8');
        const parsed = parseDependabotConfig(text);
        return { present: true, path: p, ...parsed, error: null };
      } catch (e) {
        if (e.status !== 404) errors.push({ scope: 'config', message: e.message });
      }
    }
    return { present: false, path: null, ecosystems: [], schedules: [], error: null };
  }

  /**
   * Open Dependabot alerts. A 403 here is meaningful data, not just an error:
   * GitHub returns it when alerts are disabled for the repo.
   */
  async fetchAlerts(full, raw, errors) {
    try {
      const data = await this.client.paginate(`/repos/${full}/dependabot/alerts?state=open&per_page=100&sort=updated`, { maxPages: 3 });
      raw.alertsEnabled = true;
      return data;
    } catch (e) {
      const msg = String(e.body || e.message).toLowerCase();
      if (e.status === 403 || e.status === 404) {
        if (msg.includes('disabled')) {
          raw.alertsEnabled = false;
          raw.alertsError = 'Dependabot alerts are disabled for this repository';
        } else {
          raw.alertsEnabled = null;
          raw.alertsError = e.status === 403
            ? 'Token lacks access to Dependabot alerts (needs security_events / repo scope)'
            : 'Dependabot alerts not available for this repository';
        }
        return [];
      }
      raw.alertsEnabled = null;
      raw.alertsError = e.message;
      errors.push({ scope: 'alerts', message: e.message });
      return [];
    }
  }

  async fetchPulls(full, errors) {
    try {
      return await this.client.paginate(`/repos/${full}/pulls?state=open&per_page=100&sort=created&direction=desc`, { maxPages: 2, allowStatus: [404] }) || [];
    } catch (e) {
      errors.push({ scope: 'pulls', message: e.message });
      return [];
    }
  }

  /**
   * Dependabot's own update jobs surface in Actions as `dynamic` events — the
   * closest thing GitHub exposes to "when did Dependabot last look at this repo".
   */
  async fetchLastDependabotRun(full, errors) {
    try {
      const data = await this.client.get(`/repos/${full}/actions/runs?event=dynamic&per_page=1`, { allowStatus: [403, 404] });
      return data?.workflow_runs?.[0]?.created_at || null;
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'dependabot-runs', message: e.message });
      return null;
    }
  }

  async fetchCodeScanning(full, errors) {
    try {
      const res = await this.client.request(`/repos/${full}/code-scanning/analyses?per_page=1`, { allowStatus: [403, 404] });
      if (res.status === 200 && Array.isArray(res.data)) {
        return { enabled: true, lastAnalysisAt: res.data[0]?.created_at || null, tool: res.data[0]?.tool?.name || null };
      }
      // 404 = code scanning genuinely not set up on this repo. 403 = the token
      // is not allowed to look (fine-grained PAT without "Code scanning
      // alerts: read"). Conflating the two once made every repo read as
      // unscanned even where CodeQL runs green, so no-access stays null.
      if (res.status === 404) return { enabled: false, lastAnalysisAt: null };
      return { enabled: null, lastAnalysisAt: null, reason: 'no-access' };
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'code-scanning', message: e.message });
      return { enabled: null, lastAnalysisAt: null };
    }
  }

  /** CI verdict for open PRs, so you can tell which update PRs are safe to merge. */
  async attachChecks(full, posture, errors) {
    const prs = [...posture.prs.dependabot, ...posture.prs.other]
      .filter(p => p.headSha)
      .slice(0, MAX_PR_CHECK_FETCHES);
    await mapLimit(prs, Math.min(4, this.config.concurrency), async pr => {
      try {
        const data = await this.client.get(`/repos/${full}/commits/${pr.headSha}/check-runs?per_page=30`, { allowStatus: [403, 404] });
        pr.checks = rollupChecks(data?.check_runs || []);
      } catch (e) {
        if (e.status !== 403 && e.status !== 404) errors.push({ scope: `checks:${pr.number}`, message: e.message });
      }
      // File lists feed the merge-train planner: bot PRs sharing a file (the
      // lockfile, almost always) must merge serially with rebases between.
      if (pr.kind !== 'dependabot' && pr.kind !== 'renovate') return;
      try {
        const files = await this.client.get(`/repos/${full}/pulls/${pr.number}/files?per_page=100`, { allowStatus: [403, 404] });
        if (Array.isArray(files)) pr.files = files.map(f => f.filename).slice(0, 50);
      } catch (e) {
        if (e.status !== 403 && e.status !== 404) errors.push({ scope: `files:${pr.number}`, message: e.message });
      }
    });
  }

  // === Read models =========================================================

  /**
   * The staleness contract: data older than 2× the refresh interval is
   * flagged stale so agents refresh-then-read instead of acting on a cache
   * that predates whatever they're about to touch.
   */
  dataFreshness(now = Date.now()) {
    const fetchedAt = this.state.fetchedAt;
    const ageMinutes = fetchedAt ? Math.floor((now - Date.parse(fetchedAt)) / 60_000) : null;
    const staleAfterMinutes = this.config.refreshMinutes * 2;
    return {
      dataAsOf: fetchedAt,
      dataAgeMinutes: ageMinutes,
      staleAfterMinutes,
      stale: ageMinutes == null ? true : ageMinutes > staleAfterMinutes
    };
  }

  getStatus() {
    return {
      configured: this.config.enabled,
      autoRefresh: this.config.autoRefresh,
      refreshMinutes: this.config.refreshMinutes,
      staleDays: this.config.staleDays,
      freshness: this.dataFreshness(),
      fetchedAt: this.state.fetchedAt,
      durationMs: this.state.durationMs,
      refreshing: Boolean(this.refreshing),
      repoCount: this.state.repos.length,
      discoveredCount: this.state.discoveredCount ?? null,
      viewer: this.state.viewer,
      rate: this.state.rate,
      errors: this.state.errors,
      owners: this.config.owners,
      apiUrl: this.config.apiUrl
    };
  }

  getRepos({ filter, search, sort = 'risk' } = {}) {
    let repos = [...this.state.repos];
    if (search) {
      const q = search.toLowerCase();
      repos = repos.filter(r => r.fullName.toLowerCase().includes(q) || (r.language || '').toLowerCase() === q);
    }
    const predicate = repoFilter(filter, this.config.staleDays);
    // Wrapped rather than passed by reference: `filter` hands the callback
    // (value, index, array), and these predicates take only the repo.
    if (predicate) repos = repos.filter(r => predicate(r));

    const comparator = repoComparator(sort);
    repos.sort((a, b) => comparator(a, b));
    return repos;
  }

  getPullRequests({ kind = 'all' } = {}) {
    const out = [];
    for (const repo of this.state.repos) {
      for (const pr of [...repo.prs.dependabot, ...repo.prs.other]) {
        if (kind === 'dependabot' && !(pr.kind === 'dependabot' || pr.kind === 'renovate')) continue;
        if (kind === 'other' && (pr.kind === 'dependabot' || pr.kind === 'renovate')) continue;
        out.push({ ...pr, repo: repo.fullName, repoUrl: repo.url, repoPrivate: repo.private });
      }
    }
    out.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    return out;
  }

  getAlerts({ severity, repo } = {}) {
    const out = [];
    for (const r of this.state.repos) {
      if (repo && r.fullName !== repo) continue;
      for (const alert of r.alerts.list) {
        if (severity && alert.severity !== severity) continue;
        out.push({ ...alert, repo: r.fullName, repoUrl: r.url });
      }
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    out.sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4) || (b.ageDays ?? 0) - (a.ageDays ?? 0));
    return out;
  }

  /** The prioritized, machine-readable work queue — one entry per executable step. */
  getActions() {
    // Re-read per call: the file is tiny, and edits apply without a restart.
    const policy = loadPolicy(this.config.policyFile);
    return {
      ...this.dataFreshness(),
      policySource: policy.source,
      actions: buildActionQueue(this.state.repos, { stalePrDays: this.config.staleDays, policy })
    };
  }

  /** Conflict-aware merge ordering: trains of serially-dependent merges. */
  getMergePlan() {
    const { actions, ...envelope } = this.getActions();
    const filesByRepo = {};
    for (const r of this.state.repos) {
      const map = {};
      for (const pr of [...(r.prs?.dependabot || []), ...(r.prs?.other || [])]) {
        if (pr.files) map[pr.number] = pr.files;
      }
      if (Object.keys(map).length) filesByRepo[r.fullName] = map;
    }
    return { ...envelope, ...buildMergePlan(actions.filter(a => a.type === 'merge_pr'), filesByRepo) };
  }

  /** Repos where dependency scanning is missing or misconfigured. */
  getCoverageGaps() {
    return this.state.repos
      .filter(r => !r.archived && r.gaps.length)
      .map(r => ({
        fullName: r.fullName,
        url: r.url,
        private: r.private,
        language: r.language,
        pushedDaysAgo: r.pushedDaysAgo,
        lastScan: r.lastScan,
        risk: r.risk,
        action: r.action,
        gaps: r.gaps
      }))
      .sort((a, b) => b.risk - a.risk);
  }

  /** Recorded scan snapshots, each with its delta from the scan before it. */
  getHistory({ days, limit } = {}) {
    return {
      ...this.dataFreshness(),
      meta: this.history.meta,
      refreshMinutes: this.config.refreshMinutes,
      snapshots: this.history.timelineWithDeltas({ days, limit })
    };
  }

  /** Daily series for charting — recorded where available, derived for the rest. */
  getTrends({ days = 90 } = {}) {
    return {
      ...this.dataFreshness(),
      refreshMinutes: this.config.refreshMinutes,
      mergeCoverage: this.mergeCoverage(),
      recorded: {
        meta: this.history.meta,
        // Every retained snapshot, not one per day — otherwise two scans in a
        // day plot as one point and the count disagrees with the scan log.
        snapshots: this.history.series({ days })
      },
      derived: buildTimeline(this.state.repos, { days, now: this.now() })
    };
  }

  /** Per-day activity cells for the heatmap. */
  getCalendar({ days = 90 } = {}) {
    return {
      ...this.dataFreshness(),
      mergeCoverage: this.mergeCoverage(),
      ...buildCalendar(this.state.repos, { days, now: this.now() })
    };
  }

  /** Every merged pull request in the collected window, newest first. */
  getMerges({ days, kind = 'all' } = {}) {
    const cutoff = days > 0 ? this.now() - days * 86_400_000 : null;
    const out = [];
    for (const repo of this.state.repos) {
      for (const merged of repo.recentMerges || []) {
        if (cutoff && Date.parse(merged.mergedAt) < cutoff) continue;
        const isBot = merged.kind === 'dependabot' || merged.kind === 'renovate';
        if (kind === 'dependabot' && !isBot) continue;
        if (kind === 'other' && isBot) continue;
        out.push({ ...merged, repo: repo.fullName, repoUrl: repo.url, repoPrivate: repo.private });
      }
    }
    out.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    return out;
  }

  /**
   * Cross-repo security posture: the scanning features that are switched on,
   * off, or invisible to this token. Distinct from coverage gaps, which are
   * only about Dependabot.
   */
  getPosture() {
    const active = this.state.repos.filter(r => !r.archived);
    const tally = pick => {
      const out = { enabled: [], disabled: [], unknown: [] };
      for (const r of active) {
        const v = pick(r);
        out[v === true ? 'enabled' : v === false ? 'disabled' : 'unknown'].push(r.fullName);
      }
      return out;
    };

    const features = {
      dependabotAlerts: tally(r => r.dependabot.alertsEnabled),
      dependabotConfig: tally(r => r.dependabot.configPresent),
      securityUpdates: tally(r => r.dependabot.securityUpdatesEnabled),
      codeScanning: tally(r => r.codeScanning?.enabled),
      secretScanning: tally(r => r.secretScanning?.enabled),
      pushProtection: tally(r => r.secretScanning?.pushProtection)
    };

    const gapCounts = {};
    for (const r of active) {
      for (const g of r.gaps || []) {
        gapCounts[g.id] = gapCounts[g.id] || { id: g.id, label: g.label, severity: g.severity, repos: [] };
        gapCounts[g.id].repos.push(r.fullName);
      }
    }

    return {
      ...this.dataFreshness(),
      activeCount: active.length,
      archivedCount: this.state.repos.length - active.length,
      summary: this.state.summary,
      features,
      gaps: Object.values(gapCounts).sort((a, b) => b.repos.length - a.repos.length),
      repos: active.map(r => ({
        fullName: r.fullName, url: r.url, private: r.private, language: r.language,
        risk: r.risk, action: r.action, pushedDaysAgo: r.pushedDaysAgo, lastScan: r.lastScan,
        alerts: r.alerts.counts,
        dependabot: {
          configPresent: r.dependabot.configPresent,
          alertsEnabled: r.dependabot.alertsEnabled,
          securityUpdatesEnabled: r.dependabot.securityUpdatesEnabled
        },
        codeScanning: r.codeScanning,
        secretScanning: r.secretScanning,
        gaps: (r.gaps || []).map(g => ({ id: g.id, label: g.label, severity: g.severity }))
      })).sort((a, b) => b.risk - a.risk || a.fullName.localeCompare(b.fullName))
    };
  }
}

module.exports = { Collector, mapLimit, parseDependabotConfig, rollupChecks, repoFilter, repoComparator };
