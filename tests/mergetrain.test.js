// Train grouping: shared files serialize, disjoint files parallelize,
// unknown files serialize conservatively. Pure — no server, no network.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildMergePlan } = require('../lib/mergetrain');

const action = (repo, pr, over = {}) => ({
  type: 'merge_pr', repo, pr, title: `bump #${pr}`, url: `https://x/${pr}`,
  verdict: 'safe_to_merge', policy: 'auto_ok', policyRule: 'auto.merge_patch',
  risk: 50, command: `gh pr merge ${pr} --repo ${repo} --squash --delete-branch`, ...over
});

describe('buildMergePlan', () => {
  it('serializes PRs sharing a lockfile into one train with rebase choreography', () => {
    const plan = buildMergePlan(
      [action('me/app', 1), action('me/app', 2)],
      { 'me/app': { 1: ['package.json', 'package-lock.json'], 2: ['package-lock.json'] } }
    );
    assert.equal(plan.repos.length, 1);
    const [repo] = plan.repos;
    assert.equal(repo.trainCount, 1);
    const [train] = repo.trains;
    assert.deepEqual(train.sharedFiles, ['package-lock.json']);
    assert.equal(train.steps.length, 2);
    assert.equal(train.steps[0].afterPr, null);
    assert.equal(train.steps[1].afterPr, 1);
    assert.match(train.steps[1].commands[0], /@dependabot rebase/);
    assert.match(train.steps[1].commands.at(-1), /gh pr merge 2/);
    // First step has no rebase step, just verify-then-merge.
    assert.ok(!train.steps[0].commands.some(c => c.includes('rebase')));
  });

  it('puts disjoint PRs in parallel trains', () => {
    const plan = buildMergePlan(
      [action('me/app', 1), action('me/app', 2)],
      { 'me/app': { 1: ['a/requirements.txt'], 2: ['b/requirements.txt'] } }
    );
    assert.equal(plan.repos[0].trainCount, 2);
    for (const t of plan.repos[0].trains) assert.equal(t.steps[0].afterPr, null);
  });

  it('folds unknown-file PRs into the largest known train, conservatively serialized', () => {
    const plan = buildMergePlan(
      [action('me/app', 1), action('me/app', 2), action('me/app', 3)],
      { 'me/app': { 1: ['package-lock.json'], 2: ['package-lock.json'] } } // #3 unknown
    );
    assert.equal(plan.repos[0].trainCount, 1);
    const [train] = plan.repos[0].trains;
    assert.equal(train.filesUnknown, true);
    assert.equal(train.steps.length, 3);
    const last = train.steps.at(-1);
    assert.equal(last.pr, 3);
    assert.match(last.why, /unknown/);
  });

  it('with no file data at all, everything is one serial train', () => {
    const plan = buildMergePlan([action('me/app', 1), action('me/app', 2)], {});
    assert.equal(plan.repos[0].trainCount, 1);
    assert.equal(plan.repos[0].trains[0].steps[1].afterPr, 1);
  });

  it('repos are independent of each other', () => {
    const plan = buildMergePlan(
      [action('me/a', 1), action('me/b', 9)],
      { 'me/a': { 1: ['package-lock.json'] }, 'me/b': { 9: ['package-lock.json'] } }
    );
    assert.equal(plan.repos.length, 2);
    for (const r of plan.repos) assert.equal(r.trains[0].steps[0].afterPr, null);
  });

  it('carries policy stamps through to steps', () => {
    const plan = buildMergePlan(
      [action('me/app', 1, { policy: 'requires_human', policyRule: 'never_auto repo match' })],
      { 'me/app': { 1: ['x'] } }
    );
    assert.equal(plan.repos[0].trains[0].steps[0].policy, 'requires_human');
  });
});
