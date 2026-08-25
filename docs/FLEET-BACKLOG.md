# Fleet backlog

Open problems across all `jtn0123/*` repos, as surfaced by this dashboard. One entry
per **root cause**, not per red PR — most red PRs in this account have been symptoms of
a much smaller number of causes, and the entries below are written to stay useful after
the individual PR numbers have gone.

Last full pass: **2026-08-25**. Board at that moment: 59 open PRs, 42 failing, 32 alerts.

Status key: **BLOCKED** = waiting on a human decision or a credential ·
**OPEN** = diagnosed, not yet fixed · **UNDIAGNOSED** = known red, cause not yet found.

---

## BLOCKED — needs a credential only you can rotate

### F1. `SONAR_TOKEN` is expired on `satellite_processor` and `landing-page`

`SonarCloud Scan` has been red on every human PR in `satellite_processor` since at least
2026-07-08. Six PRs merged straight past it. It is **not a required check** (`main`
requires only `Gitleaks Secret Scan` and `CI Gate`), so nothing forced anyone to look.

Confirmed by SonarCloud itself, not inferred — `api/authentication/validate` returns
`false` for the stored token, while:

| Evidence | Result |
|---|---|
| `api/components/show?component=jtn0123_satellite_processor` (anonymous) | project **exists** |
| `api/components/show?component=jtn0123_landing-page` (anonymous) | project **exists** |
| `audit-dashboard`, with its own `SONAR_TOKEN` secret | scans **green** |

So the binding and organization are fine and the credential is dead.

**Fix:** sonarcloud.io → My Account → Security → generate; update the `SONAR_TOKEN` repo
secret on `satellite_processor` and `landing-page`.

A preflight now reports this in ~2s with the cause named, instead of the scanner's
`ERROR Failed to query JRE metadata: .` thirty seconds in. `landing-page` already carries
`continue-on-error: true` on its Sonar job, so only the token is outstanding there.

---

## BLOCKED — needs a judgement call, not work

### M1. Major bumps whose changed workflow CI never actually ran

Green CI on these means nothing, because the job that would exercise the change did not
execute on the PR. Merging them looks safe and breaks later, somewhere else.

| PR | bump | why CI is not evidence |
|---|---|---|
| `MegaBonk#224` | `codecov-action` 6 → 7 | `Unit Tests` was **skipped** — the upload step never ran |
| `ESP32-S3-display-dashboard#15` | `deploy-pages` 4 → 5 | no docs/pages job runs on PRs at all |

Each fails on the *next* real use: a coverage upload, and a Pages deploy.

### M2. Runtime/toolchain majors needing domain knowledge

| PR | bump | the question |
|---|---|---|
| `binocular#53` | `react-native-gesture-handler` 2.32 → 3.2.1 | the APK builds; that does not mean gestures still behave |
| `VoltTracker#11` | `typescript` 6.0.3 → 7.x | 4 genuine CI failures — a real migration, not a version nudge |

`landing-page#55` and `satellite_processor#677` are the same TypeScript 5 → 7 decision in
two more repos. Worth taking once, account-wide, rather than four times.

---

## OPEN — diagnosed, fix not yet written

### C1. `emulator-smoke` is broken on `VoltTracker` `main`

Blocks `#23`, `#26`, `#33` via the `ci-success` gate. Confirmed pre-existing: `main` itself
reports `emulator-smoke` and `ci-success` as failing, so these PRs inherit it and did not
cause it. Cause not yet investigated.

### C2. `GOES_VFI` — 161 ruff violations behind a gate that was already red

```
 53  B023  function-uses-loop-variable   ← a live bug class, not style
 50  C901  complex-structure
 23  S108  hardcoded-temp-file
 11  B043  del-attr-with-constant        ← auto-fixable
  6  F401  unused-import                 ← auto-fixable
 18  assorted (S106, S311, B025, E721, …)
```

Only 17 auto-fixable. The 53 `B023`s are the interesting ones: a closure capturing a loop
variable is a real defect pattern, and there are 53.

These accumulated *because* `lint` was already failing — a red gate stops carrying
information, so nothing pushed back on the count.

### C3. `GOES_VFI` test suite now runs and reports genuine failures

`#95` took the suite from **cannot start** to **runs and reports real results** across three
layers (a `.gitignore`d conftest helper; a stale `QMessageBox` patch target; a missing
`pytest-timeout` that made macOS/Windows exit 4 in three seconds). Exit codes now mean what
they say. What remains are actual test failures, which is a separate and larger job.

`#95` and `#94` are both `MERGEABLE/UNSTABLE` with failures identical to `main`.

### C4. `VoltTracker` Compose layer is largely untested

`#35` restored the aggregate BRANCH ratchet to its 0.77 floor, but not the trend. The
Compose rewrite added ~1,000 branches carrying little coverage — `TripProfileChartKt` 2.9%,
`ComposeDashboardActivity` 0%, `MapTileCompositor` 0%, `VoltChartsKt` 35.5%. The next
sizeable UI addition breaches the floor again.

### C5. `tab-s6-kiosk` has no `dependabot.yml`

The only coverage gap in 22 repos, and the only repo the board has **never** seen scanned.
One file.

---

## OPEN — security

### S1. `ip-address` — 12 of 32 alerts, and not fixable in these repos

4 high + 8 medium across `satellite_processor`, `compresso`, `MegaBonk`, `SatGlobe`
(GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg). All one chain:

```
@semantic-release/npm   (devDependency)
  └─ npm@11.19.0        ← bundled
       └─ make-fetch-happen → socks → ip-address@10.2.0
```

Three reasons this has sat unfixed and will keep sitting:

1. **dev-only** — `dev: true` in every lockfile; never shipped
2. **bundled inside `npm`** — npm ships its dependencies bundled, so an `overrides` entry
   cannot reach it and Dependabot cannot bump it
3. **already on the newest npm 11.x** (11.19.0) — the patched line is npm 12.x, which
   arrives only when `@semantic-release/npm` moves to it

Real exposure is a SOCKS-proxy address parser inside the release tool's bundled package
manager, reachable only via a hostile SOCKS proxy during a release.

**Recommended:** dismiss all twelve as *"vulnerable code is not actually used"*. That is
honest rather than cosmetic, and clears 37.5% of the alert backlog. Dismissing alerts is a
security decision, so it needs a human.

### S2. `compresso` — the alerts that are real

Risk 97, the highest on the board. `tar` (GHSA-r292-9mhp-454m, uncatchable stack-overflow
DoS) and `brace-expansion` ×2 are genuine application dependencies, unlike S1.

---

## UNDIAGNOSED

### U1. `satellite_processor` — 13 red PRs after the runner fix

`API Contract Validation` was pinned to a self-hosted pool deleted from the host; moving it
to `ubuntu-latest` took it from a 24-hour queue timeout to passing in ~30s. The repo still
shows 13 failing PRs, cause not yet re-checked after that landed.

### U2. Duplicate `pip` PRs may still be regenerating

Two overlapping `pip` entries were producing four identical PR pairs; the `/backend` entry
was removed. Dependabot should retire the `dependabot/pip/backend/*` PRs on its next run —
unverified.

---

## Standing lesson

Three separate failures in this account shared one shape: **a broken signal is worse than
no signal.**

- `audit-dashboard` restarted **3,109 times** while `/healthz` passed between kills
- `GOES_VFI` accumulated **161 lint violations** behind an already-red linter
- `SonarCloud Scan` sat red for **six weeks** and was merged past six times

In each case the alarm was sounding and had stopped meaning anything. Worth weighting
"this check has been red for N days" more heavily than "this check is red" — a permanently
red gate is an outage, not a finding.
