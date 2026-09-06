// Pure-function coverage for the verdict engine and action queue — the triage
// judgement agents rely on. No network, no server.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { semverBumpType, lowerBoundOf, bumpEcosystem, prVerdict, buildActionQueue } = require('../lib/verdicts');

const DAY = 86_400_000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();

// Minimal normalized-PR factory matching posture.js normalizePr output.
function pr(over = {}) {
  return {
    number: 1, title: 'bump thing from 1.0.0 to 1.0.1', url: 'https://x/pr/1',
    author: 'dependabot[bot]', kind: 'dependabot', draft: false,
    createdAt: ago(2), updatedAt: ago(1), ageDays: 2, labels: [],
    baseRef: 'main', headRef: 'dependabot/npm_and_yarn/thing-1.0.1', headSha: 'abc',
    bump: { package: 'thing', from: '1.0.0', to: '1.0.1' },
    checks: { state: 'passing', total: 3, failing: 0, pending: 0 },
    mergeable: null,
    ...over
  };
}

describe('semverBumpType', () => {
  it('classifies major/minor/patch', () => {
    assert.equal(semverBumpType('4.22.1', '5.2.1'), 'major');
    assert.equal(semverBumpType('4.21.0', '4.22.2'), 'minor');
    assert.equal(semverBumpType('1.20.4', '1.20.6'), 'patch');
  });
  it('handles v-prefixes and suffixed tags', () => {
    assert.equal(semverBumpType('v3', 'v4'), 'major');
    assert.equal(semverBumpType('25-alpine', '26-alpine'), 'major');
  });
  it('refuses to guess on non-numeric versions', () => {
    assert.equal(semverBumpType('deadbeef', 'cafef00d'), 'unknown');
    assert.equal(semverBumpType(undefined, '1.0.0'), 'unknown');
  });

  it('classifies pip requirement specifiers by their lower bound', () => {
    // "update X requirement from A to B" titles carry specifiers, not versions.
    assert.equal(semverBumpType('>=2.37.0', '>=2.37.1'), 'patch');
    assert.equal(semverBumpType('<2.0,>=1.9.2', '>=1.9.3,<2.0'), 'patch');
    assert.equal(semverBumpType('<7,>=6.6', '>=6.11.1'), 'minor');
    assert.equal(semverBumpType('<10,>=8', '>=9.1.1'), 'major');
  });

  it('stays unknown when a specifier has no lower bound to compare', () => {
    // An upper-bound-only change has no semver level; guessing would be worse
    // than admitting it.
    assert.equal(semverBumpType('<5', '>=4.9,<5'), 'unknown');
  });
});

describe('lowerBoundOf', () => {
  it('picks the floor out of a comma-joined specifier', () => {
    assert.equal(lowerBoundOf('>=2.37.0'), '2.37.0');
    assert.equal(lowerBoundOf('<2.0,>=1.9.2'), '1.9.2');
    assert.equal(lowerBoundOf('~=1.4.2'), '1.4.2');
  });
  it('treats a bare version as its own lower bound', () => {
    assert.equal(lowerBoundOf('4.21.0'), '4.21.0');
  });
  it('returns null when there is no lower bound at all', () => {
    assert.equal(lowerBoundOf('<5'), null);
    assert.equal(lowerBoundOf('deadbeef'), null);
    assert.equal(lowerBoundOf(''), null);
  });
});

describe('bumpEcosystem', () => {
  it('reads the ecosystem out of dependabot head refs', () => {
    assert.equal(bumpEcosystem('dependabot/github_actions/actions/checkout-6'), 'github_actions');
    assert.equal(bumpEcosystem('dependabot/npm_and_yarn/express-5.2.1'), 'npm_and_yarn');
    assert.equal(bumpEcosystem('feature/foo'), null);
  });
});

describe('prVerdict', () => {
  it('green patch/minor bot PR is safe to merge', () => {
    assert.equal(prVerdict(pr()).verdict, 'safe_to_merge');
  });
  it('major bump is flagged breaking even when green', () => {
    const v = prVerdict(pr({ bump: { package: 'express', from: '4.22.1', to: '5.2.1' } }));
    assert.equal(v.verdict, 'breaking_major');
  });
  it('red CI wins over everything except supersession', () => {
    const v = prVerdict(pr({ checks: { state: 'failing', total: 3, failing: 1, pending: 0 } }));
    assert.equal(v.verdict, 'red_ci');
  });
  it('workflow bumps need a human even when green', () => {
    const v = prVerdict(pr({ headRef: 'dependabot/github_actions/actions/checkout-6' }));
    assert.equal(v.verdict, 'needs_human');
  });
  it('human PRs are never auto-mergeable', () => {
    assert.equal(prVerdict(pr({ kind: 'human', author: 'justin' })).verdict, 'needs_human');
  });
  it('drafts and pending CI produce no actionable verdict', () => {
    assert.equal(prVerdict(pr({ draft: true })).verdict, 'draft');
    assert.equal(prVerdict(pr({ checks: { state: 'pending', total: 3, failing: 0, pending: 2 } })).verdict, 'ci_pending');
  });
  it('missing CI is a judgement call, not a green light', () => {
    assert.equal(prVerdict(pr({ checks: { state: 'none', total: 0, failing: 0, pending: 0 } })).verdict, 'no_ci');
  });
  it('detects supersession by an equal-or-newer sibling (the #23-vs-#30 case)', () => {
    const older = pr({ number: 23, bump: { package: 'express', from: '4.21.0', to: '4.22.1' } });
    const newer = pr({ number: 30, bump: { package: 'express', from: '4.21.0', to: '4.22.2' } });
    const v = prVerdict(older, [older, newer]);
    assert.equal(v.verdict, 'superseded');
    assert.equal(v.supersededBy, 30);
    // The newer one is NOT superseded by the older one.
    assert.equal(prVerdict(newer, [older, newer]).verdict, 'safe_to_merge');
  });
});

describe('buildActionQueue', () => {
  const repoBase = {
    fullName: 'me/app', archived: false, risk: 40, gaps: [],
    prs: { dependabot: [], other: [], counts: {} }
  };

  it('emits merge commands with preconditions for safe PRs', () => {
    const q = buildActionQueue([{ ...repoBase, prs: { dependabot: [pr()], other: [] } }]);
    assert.equal(q.length, 1);
    assert.equal(q[0].type, 'merge_pr');
    assert.match(q[0].command, /gh pr merge 1 --repo me\/app --squash/);
    assert.ok(q[0].preconditions.length >= 2);
  });

  it('orders executable, high-impact work first', () => {
    const repos = [
      { ...repoBase, fullName: 'me/gappy', risk: 90, gaps: [{ id: 'alerts-disabled' }, { id: 'no-dependabot-config' }] },
      { ...repoBase, fullName: 'me/app', risk: 40, prs: { dependabot: [pr()], other: [] } },
      {
        ...repoBase, fullName: 'me/flagged', risk: 70,
        prs: { dependabot: [pr({ number: 8, bump: { package: 'express', from: '4.22.1', to: '5.2.1' } })], other: [] }
      }
    ];
    const q = buildActionQueue(repos);
    assert.deepEqual(q.map(a => a.type), ['enable_alerts', 'merge_pr', 'add_dependabot_config', 'flag_pr']);
  });

  it('skips archived repos and quiet PR states entirely', () => {
    const q = buildActionQueue([
      { ...repoBase, archived: true, gaps: [{ id: 'alerts-disabled' }] },
      { ...repoBase, prs: { dependabot: [pr({ draft: true }), pr({ number: 2, checks: { state: 'pending', total: 1, failing: 0, pending: 1 } })], other: [] } }
    ]);
    assert.deepEqual(q, []);
  });

  it('close command references the superseding PR', () => {
    const older = pr({ number: 23, bump: { package: 'express', from: '4.21.0', to: '4.22.1' } });
    const newer = pr({ number: 30, bump: { package: 'express', from: '4.21.0', to: '4.22.2' } });
    const q = buildActionQueue([{ ...repoBase, prs: { dependabot: [older, newer], other: [] } }]);
    const close = q.find(a => a.type === 'close_superseded');
    assert.ok(close);
    assert.equal(close.supersededBy, 30);
    assert.match(close.command, /Superseded by #30/);
  });
});
