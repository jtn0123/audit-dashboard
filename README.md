# ⬡ Patch Board

A self-hosted dashboard that answers one question across **all** your GitHub repos:
**where do I need to patch things?**

It pulls Dependabot alerts, Dependabot configuration, scan freshness and every open pull
request from the GitHub API, and puts them in one table. It also tells you which repos have
no Dependabot set up at all — the gap you can't see from GitHub's own security overview
unless you click through each repo.

Runs on your own network. No data leaves the box except read-only calls to GitHub.

## What you see

| View | What it answers |
|------|-----------------|
| **Patch board** (`/`) | One row per repo: Dependabot state, open alerts by severity, open PRs, last scan, and the single next action. Sorted by risk. |
| **Advisories** (`/#/advisories`) | One row per advisory instead of per repo: how many repos a single CVE hits, how old the oldest instance is, and a copyable list of every repo to patch. |
| **Packages** (`/#/packages`) | "A CVE just dropped — do I even use this?" Searches every repo's dependency graph, so it answers before an alert exists and covers packages that never get one. |
| **Pull requests** (`/#/prs`) | Every open PR across every repo — Dependabot updates and human PRs — with CI status and age. |
| **Coverage** (`/#/coverage`) | Repos with no `dependabot.yml`, alerts disabled, security updates off, or a stale scan — each with a one-click fix link. |
| **Timeline** (`/#/timeline`) | Alerts, coverage and PR counts over time — one snapshot per scan, so you can see whether the portfolio is getting better. |
| **Audits** (`/#/audits`) | The original nightly multi-agent audit views (Trends, History, Findings, Calendar) — unchanged. |

Each repo row expands to show the actual advisories (package, severity, fixed version),
secret- and code-scanning alerts, dismissed alerts and why they were dismissed, the update
PRs with their CI verdict, and — for repos with nothing configured — a ready-to-commit
`dependabot.yml` with a link that opens GitHub's file editor pre-filled.

The board also remembers what it looked like last time you opened it: a banner names what
moved since your last visit, and each row carries a sparkline of its alert count.

**Keyboard:** `/` search · `j`/`k` move · `Enter` expand · `o` open on GitHub · `r` rescan ·
`?` help. Filters, sort and search live in the URL, so any view of the board is a bookmark.

## Quick start

```bash
cp .env.example .env      # add your GITHUB_TOKEN
docker compose up -d
```

Open `http://localhost:3002`. The first scan runs at startup and takes a few seconds per repo.

### The token

A **fine-grained PAT**, read-only, with these repository permissions:

| Permission | Why |
|------------|-----|
| Metadata: Read | List repos |
| Dependabot alerts: Read | Open vulnerability alerts |
| Pull requests: Read | Open PRs + CI status |
| Contents: Read | Detect `.github/dependabot.yml` |
| Actions: Read | "Last Dependabot run" timestamp, default-branch CI health |
| Administration: Read | Whether alerts / security updates are enabled |
| Code scanning alerts: Read | CodeQL findings as board rows *(optional)* |
| Secret scanning alerts: Read | Leaked credentials as board rows *(optional)* |

A classic PAT with `repo` + `security_events` also works, but prefer the fine-grained one:
the classic `repo` scope grants full **read/write** access to all your repositories, far more
than this dashboard needs. By default the dashboard only ever issues read requests — the
single write it can perform (merging a green Dependabot PR) is off unless you turn it on.

The optional scopes degrade quietly: without them the extra collectors report an error for
that repo and the rest of the board still works. Turn a collector off entirely with its
`GH_COLLECT_*` flag if you'd rather not grant the scope at all.

### Merging from the dashboard (optional)

Set `GH_ALLOW_WRITES=true` and give the token **Pull requests: Read and write** to get merge
controls on green Dependabot PRs. Only bot-authored dependency updates whose CI is passing
and which aren't drafts can be selected; merges run one at a time, because merging changes
the base branch and a parallel batch leaves the rest conflicted. With the flag off, the merge
endpoint returns 403 and no write ever reaches GitHub — the deployment is read-only by default.

## Configuration

All optional except `GITHUB_TOKEN`. See `.env.example`.

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | PAT. Without it the GitHub views show a setup screen and the rest of the app still works. |
| `GH_OWNERS` | *(all accessible)* | Comma-separated users/orgs to scan |
| `GH_REPOS_INCLUDE` / `GH_REPOS_EXCLUDE` | — | Comma-separated globs, matched against `owner/repo` and `repo` |
| `GH_INCLUDE_ARCHIVED` | `false` | Include archived repos (risk is discounted 4× when shown) |
| `GH_INCLUDE_FORKS` | `false` | Include forks |
| `GH_INCLUDE_PRIVATE` | `true` | Include private repos |
| `GH_REFRESH_MINUTES` | `30` | Background poll interval (floor: 5) |
| `GH_STALE_DAYS` | `14` | Older than this with no scan evidence → flagged stale |
| `GH_CONCURRENCY` | `6` | Parallel repo fetches |
| `GH_MAX_REPOS` | `300` | Safety cap |
| `GH_AUTO_REFRESH` | `true` | `false` = only refresh via the Rescan button |
| `GH_CACHE_FILE` | `.cache/github.json` | Warm cache + ETag store |
| `GH_SLA_CRITICAL_DAYS` | `7` | Age budget: a critical alert older than this is flagged |
| `GH_SLA_HIGH_DAYS` | `30` | Age budget for high |
| `GH_SLA_MEDIUM_DAYS` | `90` | Age budget for medium |
| `GH_SLA_LOW_DAYS` | `180` | Age budget for low |
| `GH_COLLECT_CODE_SCANNING` | `true` | Fetch open code-scanning (CodeQL) alerts |
| `GH_COLLECT_SECRET_SCANNING` | `true` | Fetch open secret-scanning alerts |
| `GH_COLLECT_CI` | `true` | Fetch default-branch CI conclusion |
| `GH_COLLECT_DOCKERFILES` | `true` | Look for Dockerfiles not covered by a `docker` ecosystem |
| `GH_COLLECT_DISMISSED` | `true` | Fetch dismissed alerts and their stated reason |
| `GH_COLLECT_SBOM` | `true` | Fetch each repo's dependency graph for the package search |
| `GH_MAX_PACKAGES_PER_REPO` | `3000` | Cap on SBOM entries indexed per repo |
| `GH_HISTORY_FILE` | `.cache/history.jsonl` | Append-only snapshot log behind Timeline |
| `GH_HISTORY_DAYS` | `180` | How long snapshots are kept |
| `GH_ALLOW_WRITES` | `false` | Enable the one-click merge of green Dependabot PRs |
| `GH_WEBHOOK_SECRET` | — | Shared secret for `POST /api/gh/webhook`; unset disables the endpoint |
| `GITHUB_API_URL` | `https://api.github.com` | Point at GitHub Enterprise |
| `DATA_DIR` | `..` | Nightly audit reports (`YYYY-MM-DD/` dirs) for the Audits views |
| `AUDIT_DATA_DIR` | — | Host path compose mounts at `/data` (compose only) |
| `PORT` | `3002` | Server port |
| `ALLOWED_ORIGINS` | — | Extra CORS origins for your LAN hostnames |

## How "last scan" is determined

GitHub has no "when did Dependabot last scan this repo" API. The board takes the freshest
of three signals and **labels which one it used** (hover the timestamp):

1. **Dependabot update job** — the most recent `dynamic` Actions run, i.e. Dependabot itself running
2. **Alert activity** — the most recent update to an open Dependabot alert
3. **Dependabot PR** — the most recent update PR it opened

If none exist, the repo shows `never` and is flagged — that usually means Dependabot has
never actually run, whatever the settings page says.

## How risk is scored

Risk drives the default sort, so the top of the table is where to start:

```text
40 × critical alerts + 18 × high + 5 × medium + 1 × low
+ 35  Dependabot alerts disabled      (nothing is scanning this repo)
+ 30  open secret-scanning alerts     (a live credential is exposed)
+ 18  no dependabot.yml               (no version-update PRs)
+ 15  an alert past its age budget
+ 12  never scanned
+ 12  default-branch CI failing       (update PRs can't merge safely)
+ 10  security updates off
+ 10  open code-scanning alerts
+ 10  scan older than GH_STALE_DAYS
+ 8   Dockerfile with no docker ecosystem
+ 3   per Dependabot PR open >14 days (max 10)
```

Archived repos are divided by 4. Capped at 100. One unpatched critical outranks a repo that
merely lacks a config — one is exploitable today, the other is a process gap.

## Push instead of poll (optional)

Polling every 30 minutes means a new critical alert can sit unseen for 29 of them. If the box
is reachable from GitHub — a tunnel, a port forward — point a webhook at it instead:

1. Set `GH_WEBHOOK_SECRET` to a random string and restart.
2. Add a webhook (repo or org level) with payload URL `https://your-host/api/gh/webhook`,
   content type `application/json`, the same secret, and these events:
   **Dependabot alerts**, **Pull requests**, **Code scanning alerts**,
   **Secret scanning alerts**, **Repositories**.

A delivery re-collects only the repo it names, so an alert costs a handful of API calls
rather than a full rescan. Requests without a valid `x-hub-signature-256` are rejected with
401 — the signature is checked in constant time before the body is parsed — and the endpoint
returns 503 while `GH_WEBHOOK_SECRET` is unset. A payload whose repository name isn't shaped
like `owner/repo` is ignored rather than sanitized downstream, since that name would
otherwise become a request path. Both the webhook (120/min) and the merge endpoint (30/min)
are rate-limited: this is the one route meant to face the internet, and it has to run an
HMAC before it can reject anything.

Keep the polling interval as a safety net; webhooks and polling are complementary, not
exclusive.

## Rate limits

A 30-repo account costs roughly 300 API calls per refresh on a cold cache with every
collector on. Most requests use conditional ETags, so subsequent refreshes cost close to
nothing for repos that haven't changed. The one exception is the dependency-graph SBOM,
which is deliberately fetched without an ETag — the payloads are megabytes and caching them
would cost more memory than the requests save. Turn it off with `GH_COLLECT_SBOM=false` if
you don't want the package search; the same goes for each other `GH_COLLECT_*` flag.

At the default 30-minute interval you'll use a small fraction of the 5,000/hour limit.
Remaining quota is shown in the header.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/gh/status` | Token state, last scan time, rate limit, errors (always answers) |
| `GET` | `/api/gh/overview` | Cross-repo rollup + coverage gaps |
| `GET` | `/api/gh/repos` | Full posture per repo — `?filter=`, `?search=`, `?sort=` |
| `GET` | `/api/gh/prs` | All open PRs — `?kind=dependabot\|other\|all` |
| `GET` | `/api/gh/alerts` | All open alerts — `?severity=`, `?repo=` |
| `GET` | `/api/gh/advisories` | Alerts pivoted to one row per advisory — `?severity=`, `?minRepos=` |
| `GET` | `/api/gh/packages` | Cross-repo dependency-graph search — `?q=` |
| `GET` | `/api/gh/history` | Every snapshot inside the retention window |
| `GET` | `/api/gh/changes` | What moved — `?since=` (ISO timestamp, required) |
| `GET` | `/api/gh/coverage` | Repos with setup gaps |
| `POST` | `/api/gh/refresh` | Force a rescan now |
| `POST` | `/api/gh/merge` | Merge one green Dependabot PR — `{repo, number, method}`; 403 unless `GH_ALLOW_WRITES` |
| `POST` | `/api/gh/webhook` | GitHub webhook receiver; requires a valid `x-hub-signature-256` |
| `GET` | `/health` | Health + version + GitHub integration state |
| `GET` | `/api/dates`, `/api/summary`, `/api/report/:date[/:agent[/md]]`, `/api/findings`, `/api/diff/:d1/:d2?`, `/api/trends` | Nightly audit data |

Everything the UI reads is a plain JSON endpoint, so it's easy to wire into Home Assistant,
a status page, or a cron job that pokes you on Slack.

## Architecture

```text
├── server.js              # Express: audit-file API + /api/gh/* read models
├── lib/
│   ├── config.js          # Env parsing, repo include/exclude globs
│   ├── github.js          # REST client — ETags, pagination, rate limits (no deps)
│   ├── collector.js       # Background poller: discovers repos, fetches signals, caches
│   ├── posture.js         # Pure: gaps, risk score, last-scan resolution, rollups
│   ├── history.js         # Append-only snapshot log + "what changed since" diffing
│   └── webhook.js         # Signature verification and per-event re-collect planning
├── public/
│   ├── js/app.js          # Audit views + router
│   ├── js/repos.js        # Patch board, advisories, packages, PRs, coverage, timeline
│   └── css/style.css
└── tests/                 # node --test; the collector is tested against a fake GitHub
```

Two runtime dependencies: `express`, and `express-rate-limit` for the two routes that make
an authorization decision. Everything else — the GitHub client, the charts, the sparklines —
is written against the standard library and the DOM, with no build step.

The collector polls on a timer and writes to a disk cache; the HTTP API only ever reads that
cache, so the UI never blocks on GitHub and a rate-limit hiccup shows stale data rather than
an error page. `lib/posture.js` is pure functions — all the scoring rules are unit-tested
without touching the network.

## Development

```bash
npm install
GITHUB_TOKEN=ghp_xxx npm start        # http://localhost:3002
npm test                              # 90 tests, no network required
npm run test:coverage                 # writes coverage/lcov.info
npm run lint
```

## License

MIT
