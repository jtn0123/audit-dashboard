'use strict';

const fs = require('fs');
const path = require('path');

const { GitHubClient, pruneEtags } = require('./github');
const { repoSelected } = require('./config');
const { buildRepoPosture, summarize, groupByAdvisory } = require('./posture');
const { History, snapshot } = require('./history');

const DEPENDABOT_CONFIG_PATHS = ['.github/dependabot.yml', '.github/dependabot.yaml'];
const MAX_PR_CHECK_FETCHES = 15;

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

/**
 * Flatten SPDX packages to {ecosystem, name, version}. GitHub names them
 * "npm:lodash"; the purl in externalRefs is more reliable when present.
 */
function normalizeSbomPackages(packages, cap = 3000) {
  const out = [];
  // This is parsed straight off the wire, so trust nothing about its shape.
  if (!Array.isArray(packages)) return out;
  for (const pkg of packages) {
    if (out.length >= cap) break;
    if (!pkg || typeof pkg !== 'object') continue;
    const purl = pkg.externalRefs?.find(r => r.referenceType === 'purl')?.referenceLocator;
    let ecosystem = null;
    let name = pkg.name || '';
    // Parsed by hand rather than by regex: `pkg:type/name@version` needs a
    // lazy group followed by an optional suffix, which backtracks badly on the
    // long names an SBOM is full of.
    if (typeof purl === 'string' && purl.startsWith('pkg:')) {
      const rest = purl.slice(4);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        ecosystem = rest.slice(0, slash);
        const tail = rest.slice(slash + 1);
        // A scoped npm name arrives percent-encoded, so the last '@' is the
        // version separator and never part of the name.
        const at = tail.lastIndexOf('@');
        try {
          name = decodeURIComponent(at > 0 ? tail.slice(0, at) : tail);
        } catch {
          name = at > 0 ? tail.slice(0, at) : tail;
        }
      }
    }
    if (!ecosystem && name.includes(':')) {
      const idx = name.indexOf(':');
      ecosystem = name.slice(0, idx);
      name = name.slice(idx + 1);
    }
    // The root entry describes the repo itself, not a dependency.
    if (!name || name.startsWith('com.github.')) continue;
    out.push({ ecosystem: ecosystem || 'unknown', name, version: pkg.versionInfo || null });
  }
  return out;
}

/**
 * Invert per-repo package lists into one package -> repos index.
 *
 * This is the "a CVE just dropped, who uses this?" lookup: it answers before
 * GitHub has opened a single alert, and it covers packages that have no
 * advisory at all.
 */
function buildPackageIndex(packagesByRepo) {
  const byKey = new Map();
  for (const [repo, packages] of packagesByRepo) {
    for (const pkg of packages) {
      const key = `${pkg.ecosystem}:${pkg.name}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { key, ecosystem: pkg.ecosystem, name: pkg.name, repos: [] };
        byKey.set(key, entry);
      }
      entry.repos.push({ repo, version: pkg.version });
    }
  }
  const entries = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { count: entries.length, repoCount: packagesByRepo.size, entries };
}

/** Roll a list of check runs up into one pass/fail/pending verdict. */
function rollupChecks(checkRuns = []) {
  if (!checkRuns.length) return { state: 'none', total: 0, failing: 0, pending: 0 };
  let failing = 0, pending = 0, passing = 0;
  for (const run of checkRuns) {
    if (run.status !== 'completed') { pending++; continue; }
    if (['success', 'neutral', 'skipped'].includes(run.conclusion)) passing++;
    else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(run.conclusion)) failing++;
    else pending++;
  }
  const state = failing ? 'failing' : pending ? 'pending' : passing ? 'passing' : 'none';
  return { state, total: checkRuns.length, failing, pending };
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
    // Filled during a refresh, then inverted into this.state.packageIndex
    this.packagesByRepo = new Map();
    this.history = new History({ file: config.historyFile, retentionDays: config.historyDays });
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
    this.loadCache();
  }

  // === Persistence =========================================================

  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.cacheFile, 'utf8'));
      if (raw && Array.isArray(raw.repos)) {
        this.state = {
          ...this.state, ...raw.state,
          repos: raw.repos,
          summary: raw.summary,
          advisories: raw.advisories || [],
          packageIndex: raw.packageIndex || null,
          fetchedAt: raw.fetchedAt
        };
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
        advisories: this.state.advisories,
        packageIndex: this.state.packageIndex,
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

  start() {
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
    this.packagesByRepo.clear();
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

    const fetchedAt = new Date(this.now()).toISOString();
    this.state = {
      configured: true,
      fetchedAt,
      durationMs: Date.now() - started,
      repos: postures,
      summary: summarize(postures, { staleDays: this.config.staleDays }),
      advisories: groupByAdvisory(postures),
      packageIndex: buildPackageIndex(this.packagesByRepo),
      errors,
      rate: { ...this.client.rate },
      viewer,
      discoveredCount: discovered.length,
      skippedCount: discovered.length - selected.length
    };
    // A run that collected nothing *and* hit errors is a failure, not a portfolio
    // where every alert was suddenly fixed. Recording it would draw a cliff in
    // the trend chart and tell the "since you last looked" banner good news that
    // never happened. An account that genuinely has no repos still gets a row.
    if (postures.length || !errors.length) {
      this.history.append(snapshot(this.state, fetchedAt));
    }
    this.saveCache();
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

    const cfg = this.config;
    const [
      config, alerts, pulls, dependabotRunAt, codeScanning,
      dismissedAlerts, codeScanningAlerts, secretAlerts, ci, dockerfiles, packages
    ] = await Promise.all([
      this.fetchDependabotConfig(full, errors),
      this.fetchAlerts(full, raw, errors),
      this.fetchPulls(full, errors),
      this.fetchLastDependabotRun(full, errors),
      this.fetchCodeScanning(full, errors),
      cfg.collectDismissed ? this.fetchDismissedAlerts(full, errors) : [],
      cfg.collectCodeScanning ? this.fetchCodeScanningAlerts(full, errors) : [],
      cfg.collectSecretScanning ? this.fetchSecretScanningAlerts(full, errors) : [],
      cfg.collectCi ? this.fetchDefaultBranchCi(raw.repo, errors) : null,
      cfg.collectDockerfiles ? this.fetchDockerfiles(full, errors) : [],
      cfg.collectSbom ? this.fetchPackages(full, errors) : []
    ]);

    raw.config = config;
    raw.alerts = alerts;
    raw.pulls = pulls;
    raw.dependabotRunAt = dependabotRunAt;
    raw.codeScanning = codeScanning;
    raw.dismissedAlerts = dismissedAlerts;
    raw.codeScanningAlerts = codeScanningAlerts;
    raw.secretAlerts = secretAlerts;
    raw.ci = ci;
    raw.dockerfiles = dockerfiles;

    const posture = buildRepoPosture(raw, {
      staleDays: cfg.staleDays,
      sla: cfg.sla,
      now: this.now()
    });
    // Packages ride alongside the posture rather than inside it: the repo list
    // endpoint would otherwise ship thousands of entries per row.
    posture.packageCount = packages.length;
    this.packagesByRepo.set(posture.fullName, packages);
    await this.attachChecks(full, posture, errors);
    posture.errors = errors;
    return posture;
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

  /**
   * Recently dismissed alerts. A dismissal is a decision, not a disappearance —
   * showing them keeps "won't fix" honest instead of invisible.
   */
  async fetchDismissedAlerts(full, errors) {
    try {
      return await this.client.paginate(
        `/repos/${full}/dependabot/alerts?state=dismissed&per_page=30&sort=updated`,
        { maxPages: 1, allowStatus: [403, 404] }) || [];
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'dismissed-alerts', message: e.message });
      return [];
    }
  }

  /** Open CodeQL / code-scanning alerts (a different feed from Dependabot's). */
  async fetchCodeScanningAlerts(full, errors) {
    try {
      return await this.client.paginate(
        `/repos/${full}/code-scanning/alerts?state=open&per_page=100`,
        { maxPages: 2, allowStatus: [403, 404] }) || [];
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'code-scanning-alerts', message: e.message });
      return [];
    }
  }

  /** Open secret-scanning alerts. 404 here usually means the feature is off. */
  async fetchSecretScanningAlerts(full, errors) {
    try {
      return await this.client.paginate(
        `/repos/${full}/secret-scanning/alerts?state=open&per_page=100`,
        { maxPages: 2, allowStatus: [403, 404] }) || [];
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'secret-scanning-alerts', message: e.message });
      return [];
    }
  }

  /**
   * Health of the default branch's most recent workflow run. A repo whose main
   * build has been red for weeks isn't merging Dependabot PRs either.
   */
  async fetchDefaultBranchCi(repo, errors) {
    const branch = repo.default_branch;
    if (!branch) return null;
    try {
      const data = await this.client.get(
        `/repos/${repo.full_name}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1&exclude_pull_requests=true`,
        { allowStatus: [403, 404] });
      const run = data?.workflow_runs?.[0];
      if (!run) return { state: 'none', branch };
      return {
        branch,
        state: run.conclusion === 'success' ? 'passing'
          : run.status !== 'completed' ? 'running'
            : run.conclusion === 'failure' || run.conclusion === 'timed_out' ? 'failing' : 'other',
        conclusion: run.conclusion,
        workflow: run.name || null,
        url: run.html_url || null,
        at: run.updated_at || run.created_at || null
      };
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'ci', message: e.message });
      return null;
    }
  }

  /**
   * Locate Dockerfiles so a repo that ships containers but has no `docker`
   * ecosystem in dependabot.yml can be flagged — base images go stale silently.
   */
  async fetchDockerfiles(full, errors) {
    try {
      const data = await this.client.get(
        `/search/code?q=${encodeURIComponent(`repo:${full} filename:Dockerfile`)}&per_page=10`,
        { allowStatus: [403, 404, 422] });
      if (data?.items) return data.items.map(i => i.path);
    } catch (e) {
      if (e.status !== 403 && e.status !== 404 && e.status !== 422) {
        errors.push({ scope: 'dockerfiles', message: e.message });
      }
    }
    // Code search is rate-limited separately and often unavailable; fall back to
    // the one path that covers the overwhelming majority of repos.
    try {
      const res = await this.client.request(`/repos/${full}/contents/Dockerfile`, { allowStatus: [404] });
      return res.status === 200 ? ['Dockerfile'] : [];
    } catch {
      return [];
    }
  }

  /**
   * Full dependency list from the dependency-graph SBOM, flattened to
   * {ecosystem, name, version}. ETags are skipped deliberately: an SBOM is
   * megabytes, and caching bodies that large would bloat the cache file far
   * more than the saved bandwidth is worth.
   */
  async fetchPackages(full, errors) {
    try {
      const data = await this.client.get(`/repos/${full}/dependency-graph/sbom`, {
        useEtag: false,
        allowStatus: [403, 404]
      });
      const pkgs = data?.sbom?.packages;
      if (!Array.isArray(pkgs)) return [];
      return normalizeSbomPackages(pkgs, this.config.maxPackagesPerRepo);
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) errors.push({ scope: 'sbom', message: e.message });
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
      if (res.status !== 200 || !Array.isArray(res.data)) return { enabled: false, lastAnalysisAt: null };
      return { enabled: true, lastAnalysisAt: res.data[0]?.created_at || null, tool: res.data[0]?.tool?.name || null };
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
    });
  }

  // === Read models =========================================================

  getStatus() {
    return {
      configured: this.config.enabled,
      autoRefresh: this.config.autoRefresh,
      refreshMinutes: this.config.refreshMinutes,
      staleDays: this.config.staleDays,
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

  /** Open alerts pivoted to one row per advisory, newest/worst first. */
  getAdvisories({ severity, minRepos } = {}) {
    let advisories = this.state.advisories || [];
    if (severity) advisories = advisories.filter(a => a.severity === severity);
    if (minRepos) advisories = advisories.filter(a => a.repoCount >= Number(minRepos));
    return advisories;
  }

  /**
   * Which repos use a package. Substring match on the package name, so
   * searching "lodash" finds "lodash" and "lodash.merge".
   */
  searchPackages(query, { limit = 50 } = {}) {
    const index = this.state.packageIndex;
    if (!index) return { count: 0, repoCount: 0, results: [], indexed: false };
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { count: index.count, repoCount: index.repoCount, results: [], indexed: true };

    const exact = [];
    const partial = [];
    for (const entry of index.entries) {
      const name = entry.name.toLowerCase();
      if (name === q) exact.push(entry);
      else if (name.includes(q)) partial.push(entry);
      if (exact.length + partial.length > 500) break;
    }
    // Exact matches first, then the widest blast radius.
    const results = [...exact, ...partial]
      .sort((a, b) => b.repos.length - a.repos.length)
      .slice(0, limit);
    return { count: index.count, repoCount: index.repoCount, indexed: true, query: q, results };
  }

  /** Snapshot history for the trends view. */
  getHistory() {
    return this.history.read();
  }

  /** What moved since a given timestamp — powers the "since you last looked" banner. */
  getChangesSince(since) {
    return this.history.changesSince(since);
  }

  /**
   * Merge a pull request. The only write this app performs, and it stays behind
   * GH_ALLOW_WRITES so a read-only deployment cannot be talked into it.
   */
  async mergePullRequest({ repo, number, method = 'squash' }) {
    if (!this.config.allowWrites) {
      const err = new Error('Writes are disabled. Set GH_ALLOW_WRITES=true and use a token with push access.');
      err.status = 403;
      throw err;
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ''))) {
      const err = new Error('Invalid repository');
      err.status = 400;
      throw err;
    }
    const prNumber = Number(number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      const err = new Error('Invalid pull request number');
      err.status = 400;
      throw err;
    }
    const mergeMethod = ['merge', 'squash', 'rebase'].includes(method) ? method : 'squash';

    const result = await this.client.request(`/repos/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      useEtag: false,
      body: { merge_method: mergeMethod }
    });
    this.forgetPullRequest(repo, prNumber);
    return { merged: true, repo, number: prNumber, method: mergeMethod, sha: result.data?.sha || null };
  }

  /**
   * Re-collect one repo and splice it into the cached state. Used by the
   * webhook path so a single alert doesn't cost a full portfolio rescan.
   */
  async recollectRepo(fullName) {
    if (!this.config.enabled) return null;
    const detail = await this.client.get(`/repos/${fullName}`, { useEtag: false });
    if (!detail || !repoSelected(detail, this.config)) return null;

    const posture = await this.collectRepo(detail);
    const idx = this.state.repos.findIndex(r => r.fullName === posture.fullName);
    if (idx >= 0) this.state.repos[idx] = posture;
    else this.state.repos.push(posture);

    this.resummarize();
    this.saveCache();
    return posture;
  }

  /** Forget a repo entirely — it was deleted, or no longer matches the filters. */
  dropRepo(fullName) {
    const before = this.state.repos.length;
    this.state.repos = this.state.repos.filter(r => r.fullName !== fullName);
    if (this.state.repos.length === before) return false;
    this.packagesByRepo.delete(fullName);
    this.resummarize();
    this.saveCache();
    return true;
  }

  /** Recompute everything derived from the repo list after a partial update. */
  resummarize() {
    this.state.repos.sort((a, b) => b.risk - a.risk || a.fullName.localeCompare(b.fullName));
    this.state.summary = summarize(this.state.repos, { staleDays: this.config.staleDays });
    this.state.advisories = groupByAdvisory(this.state.repos);
    if (this.packagesByRepo.size) this.state.packageIndex = buildPackageIndex(this.packagesByRepo);
  }

  /** Drop a PR from the cached state so the UI updates without a full rescan. */
  forgetPullRequest(fullName, number) {
    const repo = this.state.repos.find(r => r.fullName === fullName);
    if (!repo) return;
    repo.prs.dependabot = repo.prs.dependabot.filter(p => p.number !== number);
    repo.prs.other = repo.prs.other.filter(p => p.number !== number);
    repo.prs.counts = {
      dependabot: repo.prs.dependabot.length,
      other: repo.prs.other.length,
      stale: repo.prs.dependabot.filter(p => (p.ageDays ?? 0) >= 14).length,
      drafts: [...repo.prs.dependabot, ...repo.prs.other].filter(p => p.draft).length,
      total: repo.prs.dependabot.length + repo.prs.other.length
    };
    this.resummarize();
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
}

module.exports = {
  Collector, mapLimit, parseDependabotConfig, rollupChecks,
  repoFilter, repoComparator, normalizeSbomPackages, buildPackageIndex
};
