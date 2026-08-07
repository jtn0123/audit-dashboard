// The digest must be honest at every data level: unconfigured, empty, populated.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildDigest } = require('../lib/digest');

describe('buildDigest', () => {
  it('says so when GitHub integration is off', () => {
    const md = buildDigest({ status: { configured: false } });
    assert.match(md, /not configured/);
    assert.match(md, /GITHUB_TOKEN/);
  });

  it('renders a clean board without inventing work', () => {
    const md = buildDigest({
      status: { configured: true, fetchedAt: '2026-08-07T05:00:00Z', rate: { remaining: 4800, limit: 5000 } },
      summary: { activeCount: 2, coverage: { covered: 2, percent: 100 }, alerts: {}, prs: { dependabot: 0, other: 0, stale: 0 } },
      actions: { dataAsOf: '2026-08-07T05:00:00Z', stale: false, actions: [] }
    });
    assert.match(md, /Nothing actionable/);
    assert.match(md, /2 active repos/);
    assert.match(md, /4800\/5000/);
  });

  it('flags stale data prominently', () => {
    const md = buildDigest({
      status: { configured: true },
      actions: { dataAsOf: '2026-08-01T00:00:00Z', stale: true, actions: [] }
    });
    assert.match(md, /\*\*stale\*\*/);
  });

  it('groups the queue by kind with mergeable PRs first', () => {
    const md = buildDigest({
      status: { configured: true },
      summary: {
        activeCount: 3, coverage: { covered: 1, percent: 33, noConfig: ['me/naked'] },
        alerts: { critical: 1, total: 1 }, prs: { dependabot: 2, other: 0, stale: 0 }
      },
      actions: {
        dataAsOf: 'x', stale: false,
        actions: [
          { type: 'merge_pr', repo: 'me/app', pr: 7, title: 'bump thing', url: 'https://x/7', why: 'green', risk: 40 },
          { type: 'flag_pr', repo: 'me/app', pr: 8, why: 'major bump', risk: 40 },
          { type: 'enable_alerts', repo: 'me/naked', why: 'alerts off', risk: 90 },
          { type: 'close_superseded', repo: 'me/app', pr: 5, why: '#7 covers it', risk: 40 }
        ]
      }
    });
    assert.match(md, /1 PR safe to merge/);
    assert.match(md, /1 coverage gap/);
    assert.match(md, /1 PR need/);
    assert.match(md, /1 superseded PR/);
    assert.match(md, /1 critical/);
    assert.ok(md.indexOf('safe to merge') < md.indexOf('coverage gap'));
  });
});
