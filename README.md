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
| **Coverage** (`/#/coverage`) | Repos with no `dependabot.yml`, alerts disabled, security updates off, or a stale scan — each with a one-click fix link. |
| **Audits** (`/#/audits`) | The original nightly multi-agent audit views (Trends, History, Findings, Calendar) — unchanged. |

Each repo row expands to show the actual advisories (package, severity, fixed version),
the update PRs with their CI verdict, and — for repos with nothing configured — a
ready-to-commit `dependabot.yml` with a link that opens GitHub's file editor pre-filled.

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
| `POST` | `/api/gh/refresh` | Force a rescan now |
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
│   └── posture.js         # Pure: gaps, risk score, last-scan resolution, rollups
├── public/
│   ├── js/app.js          # Audit views + router
│   ├── js/repos.js        # Patch board, PR and coverage views
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
