/**
 * Generate market/index.json (plugin market index format 1) for this repository.
 *
 * Run it AFTER the release commit is pushed:
 *
 *   node market/make-index.mjs <40-hex commit sha>          # the version in package.json
 *   node market/make-index.mjs --all                        # every version in market/versions.json
 *
 * Version 1 of this generator kept only the newest entry, which is how the published index
 * ended up pinned to v1.1.1 for two releases. The list of published versions now lives in
 * market/versions.json and this script only ever renders it, so an entry cannot be dropped by
 * accident.
 *
 * A git source must be pinned to a 40-hex commit SHA: the validator refuses ranges and refs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Node 18 does not provide import.meta.dirname (added in Node 20.11), while package.json
// declares node >= 18, so the repository root is derived from the module URL instead.
const repoDir = path.dirname(fileURLToPath(import.meta.url));

const repo = 'https://github.com/520limited/dsh-zotero-sync';
const root = path.resolve(repoDir, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const zh = JSON.parse(readFileSync(path.join(root, 'locale/zh.json'), 'utf8'));
const en = JSON.parse(readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
const iconSvg = readFileSync(path.join(root, 'icon.svg'), 'utf8');

const arg = process.argv[2];
const useAll = arg === '--all';
if (!useAll && !/^[0-9a-f]{40}$/u.test(arg || '')) {
  console.error('usage: node market/make-index.mjs <40-hex commit sha>');
  console.error('       node market/make-index.mjs --all   (render every version in market/versions.json)');
  process.exit(1);
}

const versionsFile = path.join(root, 'market', 'versions.json');
if (!existsSync(versionsFile)) {
  console.error('missing market/versions.json — it is the source of truth for published versions');
  process.exit(1);
}
const registry = JSON.parse(readFileSync(versionsFile, 'utf8'));

// --all renders the registry as-is. A single SHA renders the registry plus (or refreshed with)
// the version currently in package.json, so a release is one command.
let versions = registry.versions.map((v) => ({ ...v }));
if (!useAll) {
  const current = { version: pkg.version, commit: arg, publishTimestamp: Math.floor(Date.now() / 1000) };
  const existing = versions.find((v) => v.version === pkg.version);
  if (existing) {
    // Regenerating the same version keeps its original release timestamp unless the commit moved.
    if (existing.commit !== arg) existing.publishTimestamp = current.publishTimestamp;
    existing.commit = arg;
  } else {
    versions.push(current);
  }
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};
versions.sort((a, b) => cmp(a.version, b.version));
for (const v of versions) {
  if (!/^[0-9a-f]{40}$/u.test(v.commit)) throw new Error(`version ${v.version} has no 40-hex commit`);
  if (!Number.isInteger(v.publishTimestamp)) throw new Error(`version ${v.version} has no publishTimestamp`);
}

// versions.json is the registry the index is rendered from, so it has to be written back;
// otherwise the two drift apart the moment a new version is added.
if (!useAll) {
  registry.versions = versions.map(({ version, commit, publishTimestamp }) => ({ version, commit, publishTimestamp }));
  writeFileSync(versionsFile, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// The icon lives next to the index and is referenced relatively; the validator resolves it
// against the index URL, so raw.githubusercontent serves it with the right image type.
writeFileSync(path.join(root, 'market', 'icon.svg'), iconSvg);

const index = {
  format: 1,
  title: { en: '520limited plugins', zh: '520limited 插件' },
  description: {
    en: 'Personal index of DeepSeek Harness plugins by 520limited.',
    zh: '520limited 的 DeepSeek Harness 插件索引。',
  },
  metadata: {
    categories: {
      productivity: { title: { en: 'Productivity', zh: '效率' } },
    },
    labels: {
      zotero: { title: { en: 'Zotero', zh: 'Zotero' } },
      'literature-notes': { title: { en: 'Literature & notes', zh: '文献与笔记' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: en.meta.title, zh: zh.meta.title },
      description: { en: en.meta.description, zh: zh.meta.description },
      icon: './icon.svg',
      author: pkg.author,
      homepage: `${repo}#readme`,
      repository: { url: repo },
      metadata: {
        category: 'productivity',
        keywords: pkg.keywords,
        labels: ['zotero', 'literature-notes'],
      },
      versions: versions.map((v) => ({
        version: v.version,
        publishTimestamp: v.publishTimestamp,
        source: { type: 'git', url: repo, commit: v.commit },
        engines: { dsh: (pkg.engines && pkg.engines.dsh) || '>=0.2.0-0' },
      })),
    },
  ],
};

writeFileSync(path.join(root, 'market', 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log('market/index.json written, version', pkg.version);
console.log('versions listed:', index.plugins[0].versions.map((v) => v.version).join(', '));
