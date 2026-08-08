'use strict';

/**
 * Conflict-aware merge ordering. Pure functions, posture.js contract.
 *
 * Two update PRs that touch the same file — the lockfile, almost always —
 * cannot merge back-to-back: the second goes DIRTY the moment the first
 * lands and needs a rebase round-trip. This module groups a repo's mergeable
 * PRs into "trains": steps within a train are strictly sequential (rebase
 * between), separate trains are independent and safe to run in parallel.
 *
 * PRs whose file list the collector could not fetch are serialized into the
 * largest train — the conservative read: unknown overlap means assume overlap.
 */

/** Group PRs into connected components on shared files. */
function groupByOverlap(prs) {
  const trains = [];
  for (const pr of prs) {
    const fileSet = new Set(pr.files || []);
    // Every existing train this PR overlaps with merges into one.
    const overlapping = pr.files == null ? [] : trains.filter(t => t.files.some(f => fileSet.has(f)));
    if (pr.files == null || overlapping.length === 0) {
      trains.push({ members: [pr], files: [...fileSet], unknown: pr.files == null });
      continue;
    }
    const target = overlapping[0];
    for (const extra of overlapping.slice(1)) {
      target.members.push(...extra.members);
      target.files.push(...extra.files);
      trains.splice(trains.indexOf(extra), 1);
    }
    target.members.push(pr);
    target.files.push(...pr.files);
  }
  // Fold unknown-file singletons into the largest known train, if one exists.
  const unknowns = trains.filter(t => t.unknown);
  const known = trains.filter(t => !t.unknown);
  if (unknowns.length && known.length) {
    const largest = known.reduce((a, b) => (b.members.length > a.members.length ? b : a));
    for (const u of unknowns) {
      largest.members.push(...u.members);
      largest.hasUnknown = true;
    }
    return known;
  }
  if (unknowns.length > 1) {
    // No file data at all: one conservative serial train.
    return [{ members: unknowns.flatMap(t => t.members), files: [], hasUnknown: true }];
  }
  return trains;
}

function sharedFiles(train) {
  const counts = new Map();
  for (const m of train.members) for (const f of m.files || []) counts.set(f, (counts.get(f) || 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f).slice(0, 5);
}

/**
 * Build the plan from merge_pr actions (policy-stamped, from buildActionQueue)
 * plus a {repo: {prNumber: files}} index taken from the postures.
 */
function buildMergePlan(mergeActions, filesByRepo = {}) {
  const byRepo = new Map();
  for (const a of mergeActions) {
    if (!byRepo.has(a.repo)) byRepo.set(a.repo, []);
    byRepo.get(a.repo).push({ ...a, files: filesByRepo[a.repo]?.[a.pr] ?? null });
  }

  const repos = [];
  for (const [repo, actions] of byRepo) {
    const gh = `--repo ${repo}`;
    const trains = groupByOverlap(actions).map(train => {
      const shared = sharedFiles(train);
      const steps = train.members.map((m, i) => {
        const prev = i > 0 ? train.members[i - 1].pr : null;
        const commands = [`gh pr checks ${m.pr} ${gh}`];
        if (prev != null) {
          commands.unshift(
            `gh pr comment ${m.pr} ${gh} --body "@dependabot rebase"`,
            `# wait for mergeStateStatus CLEAN: gh pr view ${m.pr} ${gh} --json mergeStateStatus`
          );
        }
        commands.push(m.command);
        return {
          seq: i + 1, pr: m.pr, title: m.title, url: m.url,
          verdict: m.verdict, policy: m.policy, policyRule: m.policyRule, risk: m.risk,
          afterPr: prev,
          why: prev == null
            ? 'first in train — merge directly'
            : (m.files == null
              ? `files unknown — serialized conservatively after #${prev}`
              : `shares ${shared[0] || 'files'} with the train — rebase after #${prev} lands`),
          commands
        };
      });
      return { sharedFiles: shared, filesUnknown: Boolean(train.hasUnknown), steps };
    });
    repos.push({ repo, trainCount: trains.length, trains });
  }

  return {
    repos,
    note: 'Steps within a train are strictly sequential (rebase between merges); separate trains — including across repos — are independent and may run in parallel. Superseded-PR closes and coverage fixes stay in /api/gh/actions; this plan covers merges only.'
  };
}

module.exports = { buildMergePlan, groupByOverlap };
