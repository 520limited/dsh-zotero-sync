#!/usr/bin/env node
/**
 * File GitHub Releases for tags that already exist (run once, by hand).
 *
 * The release workflow only runs for tags pushed after it was added, so the older tags have no
 * Release page. This uses the GitHub API with a token from the environment; it never stores one.
 *
 *   GITHUB_TOKEN=... node market/backfill-releases.mjs          # dry run: print what would happen
 *   GITHUB_TOKEN=... node market/backfill-releases.mjs --apply  # actually create the releases
 *
 * Notes come from the matching CHANGELOG section when there is one, otherwise from the commits
 * since the previous tag.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const owner = '520limited';
const name = 'dsh-zotero-sync';
const api = `https://api.github.com/repos/${owner}/${name}`;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const apply = process.argv.includes('--apply');

if (!token) {
  console.error('set GITHUB_TOKEN (a token with `contents: write` on this repository)');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: path.join(repoDir, '..'), encoding: 'utf8' }).trim();
const tags = git('tag', '--sort=v:refname').split('\n').filter(Boolean);

const changelogPath = path.join(repoDir, '..', 'CHANGELOG.md');
let changelog = '';
try { changelog = readFileSync(changelogPath, 'utf8'); } catch { /* optional */ }

function notesFor(version, previous) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## [')) { end = i; break; }
    }
    return lines.slice(start + 1, end).join('\n').trim();
  }
  const range = previous ? `${previous}..${version}` : version;
  return git('log', '--no-merges', '--pretty=- %s', range);
}

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-zotero-sync-release-backfill',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : null };
}

const existing = await call('GET', `${api}/releases?per_page=100`);
if (!existing.ok) {
  console.error('cannot list releases:', existing.status, existing.json?.message);
  process.exit(1);
}
const have = new Set(existing.json.map((r) => r.tag_name));

for (const [i, tag] of tags.entries()) {
  if (have.has(tag)) { console.log(`skip    ${tag} (release exists)`); continue; }
  const version = tag.replace(/^v/u, '');
  const previous = i > 0 ? tags[i - 1] : null;
  const body = notesFor(version, previous) || `See the repository at ${tag}.`;
  if (!apply) {
    console.log(`dry-run ${tag}  (${body.split('\n').length} lines of notes)`);
    continue;
  }
  const created = await call('POST', `${api}/releases`, {
    tag_name: tag,
    name: tag,
    body,
    draft: false,
    prerelease: version.includes('-'),
  });
  console.log(created.ok ? `created ${tag}` : `FAILED  ${tag}: ${created.status} ${created.json?.message}`);
}
