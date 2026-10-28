/**
 * Generate market/index.json (plugin market index format 1) for this repository.
 *
 * The git source of a version must be pinned to a 40-hex commit SHA, so run this AFTER the
 * release commit is pushed, passing that commit:
 *
 *   node market/make-index.mjs <commit-sha>
 *
 * It rewrites market/index.json with the new commit and current package metadata, then you
 * commit the index itself. The publishTimestamp stays at the package release time.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const repo = 'https://github.com/520limited/dsh-zotero-sync';
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const zh = JSON.parse(readFileSync(path.join(root, 'locale/zh.json'), 'utf8'));
const en = JSON.parse(readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
const iconSvg = readFileSync(path.join(root, 'icon.svg'), 'utf8');

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/u.test(commit || '')) {
  console.error('usage: node market/make-index.mjs <40-hex commit sha>');
  process.exit(1);
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
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: repo, commit },
          engines: { dsh: (pkg.engines && pkg.engines.dsh) || '>=0.2.0-0' },
        },
      ],
    },
  ],
};

const file = path.join(root, 'market', 'index.json');
let existing = null;
try {
  existing = JSON.parse(readFileSync(file, 'utf8'));
} catch { /* first generation */ }
// Keep the original release timestamp when regenerating for a newer commit.
const prev = existing?.plugins?.find((p) => p.name === pkg.name)?.versions?.[0];
if (prev && prev.version === pkg.version) {
  index.plugins[0].versions[0].publishTimestamp = prev.publishTimestamp;
}

writeFileSync(file, JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log('market/index.json written for commit', commit.slice(0, 10), 'version', pkg.version);
