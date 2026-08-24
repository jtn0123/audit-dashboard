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
| **Pull requests** (`/#/prs`) | Every open PR across every repo — Dependabot updates and human PRs — with CI status and age. |
| **Findings** (`/#/findings`) | Every open Dependabot alert across every repo, searchable and groupable by package — one package causing five alerts shows as one row. |
| **Coverage** (`/#/coverage`) | Repos with no `dependabot.yml`, alerts disabled, security updates off, or a stale scan — each with a one-click fix link. |
| **Posture** (`/#/posture`) | Wider than Dependabot: code scanning, secret scanning and push protection per repo. Distinguishes *off* from *not visible to this token*. |
| **Trends** (`/#/trends`) | Alert backlog and patch activity over time. Is the backlog growing faster than you patch it? |
| **History** (`/#/history`) | What actually got patched — merged pull requests by day — plus the log of every scan this dashboard has run. |
| **Calendar** (`/#/calendar`) | 13-week heatmap of alerts raised, PRs opened and updates merged. Click a day for what happened. |

Each repo row expands to show the actual advisories (package, severity, fixed version),
the update PRs with their CI verdict, and — for repos with nothing configured — a
ready-to-commit `dependabot.yml` with a link that opens GitHub's file editor pre-filled.

### Where "history" comes from

GitHub has no API for "how many alerts were open last Tuesday". Trends, History and
Calendar therefore draw on two different sources, and the UI never blurs them:

- **Recorded** — every completed scan appends a small snapshot to `GH_HISTORY_FILE` on
  the cache volume. Exact, but it only covers the time since this dashboard first ran,
  so it is empty on day one and gains a point per scan.
- **Derived** — every open alert and PR carries the date it was raised, and merged
  update PRs carry the date they landed, so the last 90 days can be reconstructed from
  a single scan. Populated immediately, but it is a **floor** for past days: an alert
  raised in May and fixed in June left nothing to count, so it never appears.

Charts label which one they are showing. Nothing here writes to GitHub, and the
snapshot file holds counts only — no credentials, no code.

## Quick start

```bash
cp .env.example .env      # add your GITHUB_TOKEN
docker compose up -d
```

Open `http://localhost:3002`. The first scan runs at startup and takes a few seconds per repo.

The container is hardened by default: digest-pinned base image, non-root user, read-only
root filesystem (tmpfs `/tmp`, named volume for the cache), all capabilities dropped,
`no-new-privileges`, a `/healthz` healthcheck, a 512 MB memory cap, and log rotation
(json-file, 10 MB × 3). The port binds to `127.0.0.1` unless you set `HOST_BIND`.

### The token

A **fine-grained PAT**, read-only, with these repository permissions:

| Permission | Why |
|------------|-----|
| Metadata: Read | List repos |
| Dependabot alerts: Read | Open vulnerability alerts |
| Pull requests: Read | Open PRs + CI status |
| Contents: Read | Detect `.github/dependabot.yml` |
| Actions: Read | "Last Dependabot run" timestamp |
| Administration: Read | Whether alerts / security updates are enabled |

A classic PAT with `repo` + `security_events` also works, but prefer the fine-grained one:
the classic `repo` scope grants full **read/write** access to all your repositories, far more
than this dashboard needs. The dashboard itself only ever issues read requests — it never
writes to GitHub — but a leaked classic token would.

## Configuration

All optional except `GITHUB_TOKEN`. See `.env.example`.

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | PAT. Optional even for the GitHub views: the **Settings page** (`#/settings`) accepts a token at runtime, stores it mode-600 on the cache volume, and it outranks this env var. Without either, the GitHub views show a setup screen and the rest of the app still works. |
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
| `GH_HISTORY_FILE` | next to the cache | Scan-snapshot series behind Trends / History / Calendar |
| `GH_HISTORY_DAYS` | `180` | How long snapshots are kept (floor: 7) |
| `GITHUB_API_URL` | `https://api.github.com` | Point at GitHub Enterprise |
| `PORT` | `3002` | Server port |
| `HOST_BIND` | `127.0.0.1` | Host interface compose binds the port to (compose only). Set to the box's LAN IP for LAN access; never a WAN-facing interface. |
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
+ 18  no dependabot.yml               (no version-update PRs)
+ 12  never scanned
+ 10  security updates off
+ 10  scan older than GH_STALE_DAYS
+ 3   per Dependabot PR open >14 days (max 10)
```

Archived repos are divided by 4. Capped at 100. One unpatched critical outranks a repo that
merely lacks a config — one is exploitable today, the other is a process gap.

## Rate limits

A 30-repo account costs roughly 200 API calls per refresh on a cold cache. Every request
uses conditional ETags, so subsequent refreshes cost close to nothing for repos that haven't
changed. At the default 30-minute interval you'll use a small fraction of the 5,000/hour
limit. Remaining quota is shown in the header.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/gh/status` | Token state, last scan time, rate limit, errors (always answers) |
| `GET` | `/api/gh/overview` | Cross-repo rollup + coverage gaps |
| `GET` | `/api/gh/repos` | Full posture per repo — `?filter=`, `?search=`, `?sort=` |
| `GET` | `/api/gh/prs` | All open PRs — `?kind=dependabot\|other\|all` |
| `GET` | `/api/gh/alerts` | All open alerts — `?severity=`, `?repo=` |
| `GET` | `/api/gh/coverage` | Repos with setup gaps |
| `GET` | `/api/gh/posture` | Cross-repo scanning posture — on / off / not visible, kept distinct |
| `GET` | `/api/gh/merges` | Recently merged PRs — `?days=`, `?kind=` |
| `GET` | `/api/gh/trends` | Daily series — `?days=`. Both the recorded and derived sources (see below) |
| `GET` | `/api/gh/history` | Recorded scans, newest first, each with its delta from the previous one |
| `GET` | `/api/gh/calendar` | Per-day activity cells — `?days=` |
| `GET` | `/api/gh/actions` | Agent-facing work queue: verdicts + literal `gh` commands, freshness-stamped |
| `GET` | `/api/gh/merge-plan` | Conflict-aware merge ordering — serial "trains" from PR file overlap, parallel otherwise |
| `POST` | `/api/gh/refresh` | Force a rescan now (blocks until the cache is fresh — refresh-then-read) |
| `GET` | `/healthz` | Liveness probe (no I/O — wired into the compose healthcheck) |
| `GET` | `/health` | Health + version + GitHub integration state |

Everything the UI reads is a plain JSON endpoint, so it's easy to wire into Home Assistant,
a status page, or a cron job that pokes you on Slack.

## Agent access (MCP)

`mcp/server.js` is a dependency-free MCP server (stdio transport) that exposes the
dashboard to AI agents as native tools: `get_status`, `refresh_and_wait`, `list_actions`,
`get_merge_plan`, `get_repo_posture`, `list_alerts`, `get_coverage_gaps`,
`get_security_posture`, `list_merges`, `get_trends`. The repo's
`.mcp.json` registers it for Claude Code automatically — sessions opened in this project
can pull the work queue and execute it with their own credentials.

The server holds no tokens and can take no action against GitHub: it only reads this
dashboard's API. Point it elsewhere with `PATCHBOARD_URL` (default `http://127.0.0.1:3002`).
For other MCP clients, run `node mcp/server.js` with stdio transport.

### Policy guardrails

`.patchboard-policy.yml` decides what an agent may execute unattended. Every queue entry
is stamped `policy: auto_ok | requires_human` plus the rule that decided it; the contract
(stated in `/llms.txt`) is that agents execute only `auto_ok`. Switches cover patch/minor
merges, docker bumps, superseding closes, and the enable-alerts/security-updates fixes;
`never_auto` globs put whole repos permanently behind a human. Policy is a brake, never an
accelerator — it cannot promote a major bump, a red-CI PR, or a human PR past its verdict.
The file is re-read on every queue request; in the container it ships with the image, so
edit → push → redeploy. Override the path with `PATCHBOARD_POLICY_FILE`.

## Architecture

```text
├── server.js              # Express: /api/gh/* read models over the collector cache
├── lib/
│   ├── config.js          # Env parsing, repo include/exclude globs
│   ├── github.js          # REST client — ETags, pagination, rate limits (no deps)
│   ├── collector.js       # Background poller: discovers repos, fetches signals, caches
│   ├── posture.js         # Pure: gaps, risk score, last-scan resolution, rollups
│   ├── history.js         # Local scan-snapshot series — the only record of "before"
│   └── timeline.js        # Pure: day buckets for trends and the calendar heatmap
├── public/
│   ├── js/app.js          # Shared helpers, hash router, chart defaults
│   ├── js/repos.js        # Patch board, PR, coverage and settings views
│   ├── js/insights.js     # Posture, trends, history, findings, calendar views
│   └── css/style.css
└── tests/                 # node --test; the collector is tested against a fake GitHub
```

The collector polls on a timer and writes to a disk cache; the HTTP API only ever reads that
cache, so the UI never blocks on GitHub and a rate-limit hiccup shows stale data rather than
an error page. `lib/posture.js` is pure functions — all the scoring rules are unit-tested
without touching the network.

## Development

```bash
npm install
GITHUB_TOKEN=ghp_xxx npm start        # http://localhost:3002
npm test                              # 53 tests, no network required
npm run test:coverage                 # writes coverage/lcov.info
npm run lint
```

## License

MIT
