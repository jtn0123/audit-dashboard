# ⬡ Audit Dashboard

A lightweight web dashboard for viewing nightly automated audit results across multiple repositories. Built with Express, vanilla JS, and Chart.js.

![Dashboard Screenshot](docs/screenshot.png)
<!-- TODO: Add actual screenshot -->

## What It Does

Displays results from a nightly multi-agent audit system that scans repos for security vulnerabilities, code quality, infrastructure health, dependency issues, performance (Lighthouse), cross-repo consistency, and roadmap priorities. Each audit run produces JSON/Markdown reports that this dashboard visualizes.

## Quick Start (Docker)

```bash
docker compose up -d
```

Dashboard available at `http://localhost:3002`

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `..` (parent dir) | Path to audit data root (contains `YYYY-MM-DD/` directories) |
| `PORT` | `3002` | Server port |

### Volume Mount

The dashboard reads audit data from `DATA_DIR`. In production, mount your audits directory:

```yaml
volumes:
  - /path/to/audits:/data
environment:
  - DATA_DIR=/data
```

Each audit run creates a date directory (`/data/2025-01-15/`) containing agent JSON and Markdown reports.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (`{ "status": "ok" }`) |
| `GET` | `/api/dates` | List available audit dates (newest first) |
| `GET` | `/api/report/:date` | All agent reports for a date (normalized) |
| `GET` | `/api/report/:date/:agent` | Single agent report |
| `GET` | `/api/report/:date/:agent/md` | Markdown version of agent report |
| `GET` | `/api/trends` | Score history across all dates/agents |

## Architecture

```
├── server.js            # Express API — reads audit JSON files, normalizes data
├── public/
│   ├── index.html       # SPA shell (hash-based routing)
│   ├── css/style.css    # Dark theme styles
│   ├── js/app.js        # Client-side routing, rendering, Chart.js integration
│   └── favicon.svg      # Hexagon favicon
├── Dockerfile           # Node 22 Alpine
└── docker-compose.yml   # Production config with volume mount
```

**Server:** Express serves static files and a REST API. It reads `YYYY-MM-DD/*.json` files from `DATA_DIR`, normalizes agent-specific schemas into a common format (status, score, summary), and serves them.

**Client:** Vanilla JS SPA with hash-based routing. Three views: Dashboard (latest audit overview), Trends (Chart.js line graphs over time), History (all past runs). No build step, no frameworks.

**Data flow:** Nightly orchestrator → spawns 8 agents → each writes JSON + Markdown → dashboard reads them.

## Local Development

```bash
npm install
# Point to your audit data (or the parent audits/ dir)
DATA_DIR=/path/to/audits node server.js
```

Open `http://localhost:3002`. The dashboard auto-reads any `YYYY-MM-DD/` directories in `DATA_DIR`.

## License

MIT
