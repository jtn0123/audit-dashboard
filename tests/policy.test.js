// Policy parsing and gating: the brake-never-accelerator contract.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_POLICY, parsePolicy, loadPolicy, evaluateAction } = require('../lib/policy');
const { buildActionQueue } = require('../lib/verdicts');

const SAMPLE = `
# comment
version: 1

auto:
  merge_patch: true
  merge_minor: false   # tightened
  docker_bumps: false
  close_superseded: true
  enable_alerts: true
  enable_security_updates: false

never_auto: me/prod-*, sacred-repo
`;

describe('parsePolicy', () => {
  it('reads switches, lists and comments', () => {
    const p = parsePolicy(SAMPLE);
    assert.equal(p.auto.merge_patch, true);
    assert.equal(p.auto.merge_minor, false);
    assert.equal(p.auto.docker_bumps, false);
    assert.equal(p.auto.enable_security_updates, false);
    assert.deepEqual(p.neverAuto, ['me/prod-*', 'sacred-repo']);
  });

  it('empty or garbage input falls back to defaults', () => {
    assert.deepEqual(parsePolicy('').auto, DEFAULT_POLICY.auto);
    assert.deepEqual(parsePolicy('not: yaml: at: all\n\t???').neverAuto, []);
  });

  it('unknown keys are ignored, not errors', () => {
    const p = parsePolicy('auto:\n  merge_patch: false\n  frobnicate: true\n');
    assert.equal(p.auto.merge_patch, false);
    assert.ok(!('frobnicate' in p.auto));
  });
});

describe('loadPolicy', () => {
  it('labels its source, and a missing file means defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
    const file = path.join(dir, 'p.yml');
    fs.writeFileSync(file, SAMPLE);
    assert.equal(loadPolicy(file).source, file);
    assert.equal(loadPolicy(file).auto.merge_minor, false);
    const missing = loadPolicy(path.join(dir, 'nope.yml'));
    assert.equal(missing.source, 'defaults');
    assert.equal(missing.auto.merge_minor, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('evaluateAction', () => {
  const merge = { type: 'merge_pr', repo: 'me/app' };

  it('default policy waves through what the verdict allowed', () => {
    assert.equal(evaluateAction(merge, DEFAULT_POLICY, { bumpType: 'patch' }).policy, 'auto_ok');
    assert.equal(evaluateAction(merge, DEFAULT_POLICY, { bumpType: 'minor' }).policy, 'auto_ok');
  });

  it('tightened switches gate matching actions down', () => {
    const p = parsePolicy(SAMPLE);
    const r = evaluateAction(merge, p, { bumpType: 'minor' });
    assert.equal(r.policy, 'requires_human');
    assert.match(r.policyRule, /merge_minor/);
    assert.equal(evaluateAction(merge, p, { ecosystem: 'docker', bumpType: 'patch' }).policy, 'requires_human');
  });

  it('never_auto globs beat every switch', () => {
    const p = parsePolicy(SAMPLE);
    const r = evaluateAction({ type: 'merge_pr', repo: 'me/prod-api' }, p, { bumpType: 'patch' });
    assert.equal(r.policy, 'requires_human');
    assert.match(r.policyRule, /never_auto/);
  });

  it('flag_pr and config gaps are never auto', () => {
    assert.equal(evaluateAction({ type: 'flag_pr', repo: 'me/app' }, DEFAULT_POLICY).policy, 'requires_human');
    assert.equal(evaluateAction({ type: 'add_dependabot_config', repo: 'me/app' }, DEFAULT_POLICY).policy, 'requires_human');
  });
});

describe('buildActionQueue policy stamps', () => {
  const repo = {
    fullName: 'me/app', archived: false, risk: 40, gaps: [{ id: 'alerts-disabled' }],
    prs: {
      dependabot: [{
        number: 7, title: 'bump thing from 1.0.0 to 1.1.0', url: 'https://x/7',
        author: 'dependabot[bot]', kind: 'dependabot', draft: false, ageDays: 1, labels: [],
        baseRef: 'main', headRef: 'dependabot/npm_and_yarn/thing-1.1.0', headSha: 'a',
        bump: { package: 'thing', from: '1.0.0', to: '1.1.0' },
        checks: { state: 'passing', total: 1, failing: 0, pending: 0 }, mergeable: null
      }],
      other: []
    }
  };

  it('every action carries policy + policyRule', () => {
    const q = buildActionQueue([repo]);
    assert.ok(q.length >= 2);
    for (const a of q) {
      assert.ok(['auto_ok', 'requires_human'].includes(a.policy), `${a.type} missing policy`);
      assert.ok(a.policyRule, `${a.type} missing policyRule`);
    }
  });

  it('a tightened policy downgrades without changing the verdict', () => {
    const q = buildActionQueue([repo], { policy: parsePolicy('auto:\n  merge_minor: false\n') });
    const m = q.find(a => a.type === 'merge_pr');
    assert.equal(m.verdict, 'safe_to_merge');   // facts unchanged
    assert.equal(m.policy, 'requires_human');   // authorization changed
  });
});
