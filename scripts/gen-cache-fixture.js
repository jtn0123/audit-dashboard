'use strict';

/**
 * Write a synthetic collector cache of roughly the requested size, shaped
 * like the real one: ETag entries whose bodies are lists of many small
 * objects. Object-heavy JSON is what makes parsing cost ~4x the file size in
 * memory, so a single big string would understate the risk.
 *
 *   node scripts/gen-cache-fixture.js <megabytes> <out-file>
 */

const fs = require('fs');

const [mbArg, out] = process.argv.slice(2);
const target = Number(mbArg) * 1048576;
if (!(target > 0) || !out) {
  console.warn('usage: gen-cache-fixture.js <megabytes> <out-file>');
  process.exit(2);
}

// GitHub embeds a full repository object (~80 fields, mostly unique URLs) in
// every PR's head and base. Those unique strings are what the parse pays for.
let seq = 0;
function repo(name) {
  const base = `https://api.github.com/repos/me/${name}`;
  const r = { id: ++seq, node_id: `R_${seq.toString(36)}`, name, full_name: `me/${name}`, private: false, fork: false };
  for (const f of ['archive', 'assignees', 'blobs', 'branches', 'collaborators', 'comments', 'commits', 'compare',
    'contents', 'contributors', 'deployments', 'downloads', 'events', 'forks', 'git_commits', 'git_refs', 'git_tags',
    'hooks', 'issue_comment', 'issue_events', 'issues', 'keys', 'labels', 'languages', 'merges', 'milestones',
    'notifications', 'pulls', 'releases', 'stargazers', 'statuses', 'subscribers', 'subscription', 'tags', 'teams', 'trees']) {
    r[`${f}_url`] = `${base}/${f}{/id}?n=${++seq}`;
  }
  r.owner = { login: 'me', id: 1, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/1?v=${++seq}` };
  return r;
}
function pull(i) {
  const sha = (++seq).toString(16).padStart(40, '0');
  return {
    url: `https://api.github.com/repos/me/app/pulls/${i}?n=${seq}`, id: seq, node_id: `PR_${seq.toString(36)}`, number: i,
    title: `build(deps): bump package-${seq} from 1.2.${i % 10} to 1.3.0`,
    html_url: `https://github.com/me/app/pull/${i}?n=${seq}`, state: 'open', locked: false, draft: false,
    body: `Bumps package-${seq} from 1.2.${i % 10} to 1.3.0. Release notes and changelog follow.`,
    user: { login: 'dependabot[bot]', id: 49699333, type: 'Bot', site_admin: false },
    head: { label: `me:dependabot/${seq}`, ref: `dependabot/npm_and_yarn/package-${seq}`, sha, repo: repo('app') },
    base: { label: 'me:main', ref: 'main', sha: sha.split('').reverse().join(''), repo: repo('app') },
    labels: [{ id: ++seq, name: 'dependencies', color: '0366d6', default: false }],
    created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-02T00:00:00Z'
  };
}

const fd = fs.openSync(out, 'w');
fs.writeSync(fd, `{"fetchedAt":"${new Date().toISOString()}","repos":[],"summary":{},"advisories":[],"state":{},"etags":{`);
let written = 0;
for (let n = 0; written < target; n++) {
  const body = JSON.stringify(Array.from({ length: 30 }, (_, i) => pull(i)));
  const chunk = `${n ? ',' : ''}"GET https://api.github.com/repos/me/app/fixture/${n}":{"etag":"\\"${n}\\"","nextUrl":null,"usedAt":${Date.now()},"data":${body}}`;
  fs.writeSync(fd, chunk);
  written += chunk.length;
}
fs.writeSync(fd, '}}');
fs.closeSync(fd);
console.log(`wrote ${(fs.statSync(out).size / 1048576).toFixed(1)} MB to ${out}`);
