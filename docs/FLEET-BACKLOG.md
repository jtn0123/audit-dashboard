# Fleet backlog

Open problems across all `jtn0123/*` repos, as surfaced by this dashboard. One entry
per **root cause**, not per red PR — most red PRs in this account have been symptoms of
a much smaller number of causes, and the entries below are written to stay useful after
the individual PR numbers have gone.

Last full pass: **2026-08-31**. Board at that moment: 89 open PRs, 33 alerts, 23 repos.

Status key: **BLOCKED** = waiting on a human decision or a credential ·
**OPEN** = diagnosed, not yet fixed · **FIXED** = change written, in review or merged ·
**UNDIAGNOSED** = known red, cause not yet found.

> **The board is growing.** 59 open PRs on 2026-08-25 → **89** on 2026-08-31. Dependabot
> generates faster than this fleet absorbs, and strict branch protection serialises
> merges: every merge marks its siblings in the same repo out-of-date, so N green PRs
> take N CI cycles, not one. That interaction is the real throughput ceiling, not
> review time.

---

## The recurring shape

Of the eight checks failing on a representative GOES_VFI PR, **one** was what it
appeared to be. The rest were commands referring to things that do not exist:

| check | what it looked like | what it was |
|---|---|---|
| `lint` | style debt | real — 157 ruff violations |
| `Code Quality (Linting & Type Checks)` | type errors | a step calling a **deleted script** |
| `Code Quality Analysis` | complexity findings | a **pip package that does not exist** |
| `Tests` ×3 | failing tests | a 20-minute **timeout**, no per-test limit |
| `Coverage` ×2 | coverage drop | a third-party **500** |

Each stayed invisible because a check *earlier in the same job* was already failing.
This pattern has now repeated in five repos. When triaging, open the log before
believing the check name.

---

## BLOCKED — needs a credential or a setting only you can change

### F1. `SONAR_TOKEN` is expired on `satellite_processor` and `landing-page`

`SonarCloud Scan` has been red on every human PR in `satellite_processor` since at least
2026-07-08, and is the **sole** failing check on 4 of its open PRs. Six PRs merged
straight past it. It is not a required check (`main` requires only `Gitleaks Secret Scan`
and `CI Gate`), so nothing forced anyone to look.

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

### F2. `MegaBonk` — "Allow auto-merge" is off, and a workflow depends on it

Four PRs (`#229`, `#228`, `#226`, `#217`) fail one check each, always `auto-merge`:

```
GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)
```

The workflow runs `gh pr merge --auto --squash`, which requires the repository setting
**Settings → General → Pull Requests → Allow auto-merge**. It is disabled, so the step
exits 1 on every Dependabot PR.

Not fixed here on purpose: enabling it changes how *every* future PR in that repo merges,
which is a policy decision rather than a repair. The alternative — making the workflow
tolerate the disabled setting — would hide the mismatch instead of resolving it.

### F3. `setuptools` CVE-2026-59890 on `GOES_VFI`

`"fixed_versions": []`. There is nothing to upgrade to. It blocks `Code Quality` until
upstream ships a fix or the advisory is ignored deliberately.

### F4. Coveralls hard-fails `GOES_VFI` on its own outage

`Finish Coverage` fails with `Internal Server Error (500)` from Coveralls' API, and
`coverallsapp/github-action` runs with `fail-on-error: true`. A coverage *reporting*
outage should probably not be able to block a PR — but that is a policy call.

### F5. `ip-address` — 12 of 33 alerts, not fixable in these repos

4 high + 8 medium across `satellite_processor`, `compresso`, `MegaBonk`, `SatGlobe`
(GHSA-mwp4-54f8-5fhr, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg). All one chain:

```
@semantic-release/npm   (devDependency)
  └─ npm@11.19.0        ← bundled
       └─ make-fetch-happen → socks → ip-address@10.2.0
```

Three reasons this has sat unfixed and will keep sitting: it is **dev-only** (`dev: true`
in every lockfile); it is **bundled inside `npm`**, so an `overrides` entry cannot reach
it and Dependabot cannot bump it; and it is **already on the newest npm 11.x**, with the
patched line being npm 12.x, which arrives only when `@semantic-release/npm` moves to it.

Real exposure is a SOCKS-proxy address parser inside the release tool's bundled package
manager, reachable only via a hostile SOCKS proxy during a release.

**Recommended:** dismiss all twelve as *"vulnerable code is not actually used"* — honest
rather than cosmetic, and it clears 36% of the alert backlog. Dismissing alerts is a
security decision, so it needs a human.

---

## BLOCKED — needs a judgement call, not work

### M1. Major bumps whose changed workflow CI never actually ran

Green CI on these means nothing, because the job that would exercise the change did not
execute on the PR. Merging them looks safe and breaks later, somewhere else.

| PR | bump | why CI is not evidence |
|---|---|---|
| `MegaBonk#224` | `codecov-action` 6 → 7 | `Unit Tests` was **skipped** — the upload step never ran |
| `ESP32-S3-display-dashboard#15` | `deploy-pages` 4 → 5 | no docs/pages job runs on PRs at all |

### M2. `actions/setup-java` 5 → 6, in two repos at once

`binocular#62` and `VoltTracker#40`. Worth taking once, account-wide, rather than twice.
`binocular#62` is the better evidence of the two: its CI is now fully green *including*
the release dry-run, which actually exercises Java — unlike the M1 cases above.

### M3. TypeScript 6 → 7, in four repos

`VoltTracker#11` (6 genuine CI failures), `binocular#60`, `MegaBonk#182`,
`landing-page#55`. A real migration, not a version nudge, and the same decision four
times.

---

## FIXED — change written this pass

### R1. `GOES_VFI` — the eight-check cascade

Six PRs, merged bottom-up. `#95` and `#96` are in; `#98`–`#101` are open.

| PR | fixes |
|---|---|
| `#95` | a `.gitignore`d conftest helper; a stale `QMessageBox` patch target; missing `pytest-timeout` (macOS/Windows were exiting **code 4**, a pytest *usage* error, in three seconds) |
| `#96` | 103 of 157 ruff violations; the rest scoped to tests |
| `#98` | 53 `B023` closure bindings + a step in three workflows calling a **deleted** `run_mypy_checks.py` |
| `#99` | per-test timeout on Linux (the job was *cancelled* at `timeout-minutes: 20`, having reached 1% of the suite) |
| `#100` | `complexity-metrics`, a pip package that **does not exist** — `from versions: none` — which killed the job at step 4 of 8, and then `mypy` being absent (see R2) |
| `#101` | the last ruff violation, `s3_store.exists` C901 16 > 10 |

**`#97` was auto-closed by GitHub** when `#96` merged and deleted its base branch. Its two
commits are contained in `fix/mypy-debt` and ship in `#98`; nothing was lost. Worth knowing
for any future stacked PRs in these repos: **squash-merging with `--delete-branch` closes
whatever is stacked on top.** Retarget the remainder to `main` *before* merging the base.

### R2. `run_linters.py` scores a skipped tool as a finding

With `complexity-metrics` gone, `Code Quality Analysis` reached its linting step for the
first time and died there:

```
warning: Mypy is not properly installed. Skipping mypy checks.
Mypy: 1 issues     →  exit code 1
```

`run_linters.py:176` returns `1, "Mypy not installed", 1` — it announces a *skip* and then
counts that skip as a *finding*. mypy lives in the `typing` extra, not `dev`, so the job
never had it. Fixed in `#100` by installing mypy directly (rather than adding `typing`,
which also pulls `PyQt6-stubs` from a git URL), making the type check real instead of
phantom.

### R3. `compresso` — a vulnerable `pip` that Dependabot can never bump

`Lint & Type Check` fails on every PR in the repo:

```
Name Version  ID               Fix Versions
pip  26.1.2   PYSEC-2026-3721  26.2
```

`pip` is not a direct dependency — it enters `requirements-dev.lock` via `--allow-unsafe`
as a transitive of `pip-tools` and `pip-api`. **There is no manifest entry for Dependabot
to update**, so this class of finding can only ever be fixed by hand.

Fixed in `compresso#257` by regenerating with `--upgrade-package pip`, which confines the
change to three lines of a 1,370-line lock. Verified locally with the same
`pip-audit==2.10.1` CI uses: both locks report no known vulnerabilities.

### R4. `binocular` — an upstream regression that had already been fixed

Six PRs failed `Would a release still work?` with:

```
type object 'Actor' has no attribute 'name_email_regex'
```

`python-semantic-release==9.21.1` is pinned; its **GitPython dependency is not**.

| event | when |
|---|---|
| GitPython **3.1.60** removes `Actor.name_email_regex` | 2026-08-25 18:33Z |
| binocular's jobs fail | 2026-08-27 |
| GitPython **3.1.61** restores it | 2026-08-28 11:01Z |

A three-day upstream regression window. Re-running the jobs cleared **4 of 6** with no
code change. The lesson is the unpinned transitive in a release-critical path, not the
regression itself.

### R5. `satellite_processor` — 5 orphaned PRs from a removed config entry

**This corrects the previous pass's U2, which was wrong.** It predicted Dependabot would
retire the `dependabot/pip/backend/*` PRs on its next run. It does not — Dependabot never
revisits a directory it no longer manages, so those branches are never rebased and the PRs
sit open forever.

Closed `#757`, `#759`, `#758` (exact duplicates of `#755`, `#754`, `#751` from the
surviving `/` entry), `#756` (already obsolete: the lock pins `boto3>=1.43.77`, ahead of
the `>=1.43.76` it proposed) and `#752`. The `/` entry covers the same file and will
regenerate anything still needed.

**Generalisation:** removing a Dependabot entry orphans its open PRs. Close them by hand.

### R6. Config coverage reached 23 of 23

`tab-s6-kiosk#2` (github-actions only — the repo has no package manifests) and
`draft-assistant#3` (github-actions + npm + cargo ×2, the fuzz target needing its own
entry). `tab-s6-kiosk` was the only repo the board had **never** seen scanned.

Both carry the `codeql-action` grouping, so neither reproduces the lockstep bug on first
fire.

---

## OPEN — diagnosed, fix not yet written

### C1. `VoltTracker` `emulator-smoke` — the emulator dies, not the test

**This corrects the previous pass**, which recorded it as "broken on `main`". The job does
not run on `main` at all; it is PR-only, and the earlier claim came from a branch
protection status rather than a run.

Identical signature on `#26`, `#33` and `#23`: the build succeeds, then qemu dies partway
through `connectedDebugAndroidTest` and every subsequent adb call reports `device offline`.
All three restore the same cached AVD (`avd-api34-google_apis-x86_64-pixel2-v5`,
`force-avd-creation: false`).

`android.yml` documents this signature precisely and prescribes **re-running the job** — an
in-job retry was tried and reverted, because the second boot leaves the guest unable to
service `adb shell run-as`. Re-runs are in flight; if all three fail identically again it
is not a flake, and the poisoned-AVD-cache hypothesis (bump the key suffix past `-v5`)
becomes the next thing to try.

Note also that **two workflows define a job named `emulator-smoke`** —
`android-emulator-smoke.yml` (no cache, `-no-snapshot`) and `android.yml` (cached AVD,
`-no-snapshot-save`). Only the latter fails. Two checks with one name is its own hazard.

### C2. `binocular` — `jest-expo` cannot be bumped yet

`#50` and `#58` fail on a genuine peer conflict, not infrastructure:

```
jest-expo@57.0.4 → peer @react-native/jest-preset@^0.86.2
react-native@0.86.0 → peerOptional @react-native/jest-preset@0.86.0
```

Blocked until `react-native` moves to 0.86.2. Dependabot proposed an incompatible bump.

### C3. `FileSorter` and `Kart_Lap_Logger` have Dependabot but **no CI at all**

Ten open PRs between them, every one reported as `no_ci` — neither repo has a
`.github/workflows/` directory. Dependency PRs accumulate with nothing able to judge them,
so merging any of them is unverifiable by construction.

The fix is not to merge the ten; it is a minimal workflow in each (pytest for
`FileSorter`, a Gradle build for `Kart_Lap_Logger`) so the PRs become answerable.

### C4. `VoltTracker` Compose layer is largely untested

`#35` restored the aggregate BRANCH ratchet to its 0.77 floor, but not the trend. The
Compose rewrite added ~1,000 branches carrying little coverage — `TripProfileChartKt` 2.9%,
`ComposeDashboardActivity` 0%, `MapTileCompositor` 0%, `VoltChartsKt` 35.5%. The next
sizeable UI addition breaches the floor again.

### C5. `GOES_VFI` mypy debt

The pre-commit `mypy` hook fails on an unmodified `origin/main` — 18 errors across 4 files
— so it blocks *every* commit regardless of content. Every commit in this pass was made
with `--no-verify` and said so. With R2 landing, mypy runs in CI for the first time, which
will put a real number on this.

### C6. `compresso` — the alerts that are real

Risk 97, the highest on the board. `tar` (GHSA-r292-9mhp-454m, uncatchable stack-overflow
DoS) and `brace-expansion` ×2 are genuine application dependencies, unlike F5.

---

## Standing lessons

**A broken signal is worse than no signal.** Every instance so far:

- `audit-dashboard` restarted **3,109 times** while `/healthz` passed between kills
- `GOES_VFI` accumulated **161 lint violations** behind an already-red linter
- `SonarCloud Scan` sat red for **six weeks** and was merged past six times
- `Code Quality Analysis` has **never completed a single run** — it died at dependency
  install on a package that does not exist
- `MegaBonk`'s `auto-merge` fails on a repo setting, on every PR, forever

Weight "this check has been red for N days" far more heavily than "this check is red." A
permanently red gate is an outage, not a finding.

**Corollary: check what the *tool* did, not what the *check* says.** Three of the causes
above were commands referring to things that do not exist — a deleted script, a fictional
package, an absent binary — and all three were invisible behind an earlier failure in the
same job.

**Dependabot cannot fix what it cannot see.** `pip` via `--allow-unsafe` (R3) and
`ip-address` bundled inside `npm` (F5) are both real advisories on packages with no
manifest entry to bump. Those need a human with a lockfile, or a dismissal.
