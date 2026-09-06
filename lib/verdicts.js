'use strict';

/**
 * Merge-readiness verdicts and the machine-readable action queue.
 *
 * Pure functions, same contract as posture.js: no network, no fs. The verdict
 * encodes triage judgement — "is this PR safe for an agent to merge, and if
 * not, why" — so agents consume a decision, not raw CI state. The dashboard
 * stays a read-only sensor/planner: every action carries the gh CLI command an
 * agent runs with its *own* credentials; nothing here writes to GitHub.
 */

// Dependabot encodes the ecosystem in the head ref: dependabot/npm_and_yarn/…,
// dependabot/github_actions/…, dependabot/docker/…
function bumpEcosystem(headRef = '') {
  const m = String(headRef).match(/^dependabot\/([^/]+)\//);
  return m ? m[1] : null;
}

/**
 * Classify a version bump as major/minor/patch. Handles v-prefixes and
 * suffixed tags like `25-alpine`; anything non-numeric (shas, dates we can't
 * order) is `unknown` — never guess "safe" from a string we can't compare.
 */
/**
 * Resolve a version specifier to the single version a bump is actually moving.
 *
 * Dependabot's "update X requirement from A to B" titles carry specifiers rather
 * than plain versions, and often several comma-joined clauses:
 *
 *   >=2.37.0          -> 2.37.0
 *   <2.0,>=1.9.2      -> 1.9.2
 *   <7,>=6.6          -> 6.6
 *   <5                -> null   (no lower bound; nothing comparable moved)
 *
 * The lower bound is the meaningful part: it is the floor the project is
 * raising. An upper-bound-only change has no semver level, and returning null
 * keeps it honestly classified as 'unknown' rather than guessed at.
 */
function lowerBoundOf(spec) {
  const clauses = String(spec || '').split(',');
  for (const clause of clauses) {
    const m = clause.trim().match(/^(?:>=|>|~=|\^|==)?\s*(v?\d[\w.\-+]*)$/i);
    if (m && /^(>=|>|~=|\^|==)/.test(clause.trim())) return m[1];
  }
  // A bare version with no operator at all ("4.21.0") is its own lower bound.
  const bare = String(spec || '').trim();
  return /^v?\d/.test(bare) ? bare : null;
}

function semverBumpType(from, to) {
  const parse = v => {
    const bound = lowerBoundOf(v);
    if (bound === null) return null;
    const m = String(bound).replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
  };
  const a = parse(from), b = parse(to);
  if (!a || !b) return 'unknown';
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  if (b[2] !== a[2]) return 'patch';
  return 'none';
}

function cmpVersions(a, b) {
  const parse = v => String(v || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

/**
 * Verdict for one normalized PR (posture.js normalizePr shape).
 * `siblings` are the other open PRs of the same repo, for supersede detection.
 */
function prVerdict(pr, siblings = [], { stalePrDays = 14 } = {}) {
  const reasons = [];
  const eco = bumpEcosystem(pr.headRef);
  const checksState = pr.checks?.state || 'none';

  if (pr.draft) return { verdict: 'draft', reasons: ['marked draft'] };

  if (pr.kind === 'human') {
    return { verdict: 'needs_human', reasons: ['human-authored — review, don\'t auto-merge'] };
  }

  // Another open bot PR bumping the same package to an equal-or-newer version
  // makes this one redundant (the #23-vs-#30 pattern).
  if (pr.bump?.package) {
    const winner = siblings.find(s =>
      s.number !== pr.number && !s.draft &&
      (s.kind === 'dependabot' || s.kind === 'renovate') &&
      s.bump?.package === pr.bump.package &&
      cmpVersions(s.bump.to, pr.bump.to) >= 0
    );
    if (winner) {
      return { verdict: 'superseded', supersededBy: winner.number, reasons: [`#${winner.number} bumps ${pr.bump.package} to ${winner.bump.to}`] };
    }
  }

  if (checksState === 'failing') {
    reasons.push(`${pr.checks.failing}/${pr.checks.total} checks failing`);
    return { verdict: 'red_ci', reasons };
  }

  const bumpType = pr.bump ? semverBumpType(pr.bump.from, pr.bump.to) : 'unknown';
  if (bumpType === 'major') {
    reasons.push(`major bump ${pr.bump.from} → ${pr.bump.to} — breaking-change review needed`);
    return { verdict: 'breaking_major', reasons };
  }

  // CI-config changes deserve eyes even when green: a workflow bump can change
  // what "green" means, and SHA-pinned workflows make tag bumps unappliable.
  if (eco === 'github_actions') {
    reasons.push('touches CI workflows');
    return { verdict: 'needs_human', reasons };
  }

  if (checksState === 'pending') return { verdict: 'ci_pending', reasons: ['checks still running'] };
  if (checksState === 'none') return { verdict: 'no_ci', reasons: ['no checks on this PR — merging is a judgement call'] };

  if ((pr.ageDays ?? 0) >= stalePrDays) reasons.push(`open ${pr.ageDays}d — base may have moved, expect a rebase`);
  reasons.push(bumpType === 'unknown' ? 'green CI, unparseable bump — verify versions' : `green CI, ${bumpType} bump`);
  return { verdict: bumpType === 'unknown' ? 'needs_human' : 'safe_to_merge', reasons };
}

// Lower rank = earlier in the queue. Executable, high-impact work first.
const ACTION_RANK = {
  enable_alerts: 0,
  merge_pr: 1,
  close_superseded: 2,
  enable_security_updates: 3,
  add_dependabot_config: 4,
  rebase_pr: 5,
  flag_pr: 6
};

const { evaluateAction, DEFAULT_POLICY } = require('./policy');

/**
 * Build the prioritized action queue for a set of repo postures
 * (posture.js buildRepoPosture shape). Every entry is one executable step,
 * stamped with the policy decision (auto_ok / requires_human + deciding rule).
 */
function buildActionQueue(repos, { stalePrDays = 14, policy = DEFAULT_POLICY } = {}) {
  const actions = [];
  const stamp = (action, extra = {}) => ({ ...action, ...evaluateAction(action, policy, extra) });

  for (const repo of repos) {
    if (repo.archived) continue;
    const full = repo.fullName;
    const gh = `--repo ${full}`;
    const allPrs = [...(repo.prs?.dependabot || []), ...(repo.prs?.other || [])];

    for (const pr of repo.prs?.dependabot || []) {
      const v = prVerdict(pr, allPrs, { stalePrDays });
      const base = {
        repo: full, pr: pr.number, title: pr.title, url: pr.url,
        verdict: v.verdict, why: v.reasons.join('; '), risk: repo.risk
      };
      const eco = bumpEcosystem(pr.headRef);
      const bumpType = pr.bump ? semverBumpType(pr.bump.from, pr.bump.to) : null;
      switch (v.verdict) {
        case 'safe_to_merge':
          actions.push(stamp({
            type: 'merge_pr', ...base,
            command: `gh pr merge ${pr.number} ${gh} --squash --delete-branch`,
            preconditions: [
              'CI verdict is as of the last refresh — re-check with: gh pr checks ' + pr.number + ' ' + gh,
              'strict branch protection may need: gh pr comment ' + pr.number + ' ' + gh + ' --body "@dependabot rebase", then wait for CLEAN'
            ]
          }, { ecosystem: eco, bumpType }));
          break;
        case 'superseded':
          actions.push(stamp({
            type: 'close_superseded', ...base, supersededBy: v.supersededBy,
            command: `gh pr close ${pr.number} ${gh} --comment "Superseded by #${v.supersededBy}"`
          }));
          break;
        case 'red_ci':
        case 'breaking_major':
        case 'needs_human':
        case 'no_ci':
          actions.push(stamp({ type: 'flag_pr', ...base, command: `gh pr view ${pr.number} ${gh}` }));
          break;
        // draft / ci_pending: nothing to do yet — deliberately not queued
      }
    }

    const hasGap = id => (repo.gaps || []).some(g => g.id === id);
    if (hasGap('alerts-disabled')) {
      actions.push(stamp({
        type: 'enable_alerts', repo: full, verdict: 'gap', risk: repo.risk,
        why: 'Dependabot alerts are off — nothing is scanning this repo',
        command: `gh api -X PUT /repos/${full}/vulnerability-alerts`
      }));
    }
    if (hasGap('security-updates-disabled')) {
      actions.push(stamp({
        type: 'enable_security_updates', repo: full, verdict: 'gap', risk: repo.risk,
        why: 'automatic security-fix PRs are off',
        command: `gh api -X PUT /repos/${full}/automated-security-fixes`
      }));
    }
    if (hasGap('no-dependabot-config')) {
      actions.push(stamp({
        type: 'add_dependabot_config', repo: full, verdict: 'gap', risk: repo.risk,
        why: 'no dependabot.yml — no version-update PRs',
        command: null,
        hint: `open a PR adding .github/dependabot.yml (the dashboard's repo row generates one for ${full})`
      }));
    }
  }

  actions.sort((a, b) =>
    (ACTION_RANK[a.type] ?? 9) - (ACTION_RANK[b.type] ?? 9) ||
    (b.risk ?? 0) - (a.risk ?? 0) ||
    a.repo.localeCompare(b.repo)
  );
  return actions;
}

module.exports = { bumpEcosystem, lowerBoundOf, semverBumpType, cmpVersions, prVerdict, buildActionQueue, ACTION_RANK };
