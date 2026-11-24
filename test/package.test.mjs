import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

// Node 18 does not provide import.meta.dirname (added in Node 20.11), while package.json
// declares node >= 18, so the repository root is derived from the module URL instead.
const repoDir = path.dirname(fileURLToPath(import.meta.url));

const pkg = path.resolve(repoDir, '..');
let fail = 0;
const need = (cond, label, extra) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (cond ? '' : '  <- ' + (extra || '')));
  if (!cond) fail++;
};

console.log('--- JSON files parse as UTF-8');
for (const f of ['package.json', 'locale/en.json', 'locale/zh.json']) {
  try {
    const doc = JSON.parse(readFileSync(path.join(pkg, f), 'utf8'));
    need(true, f, '');
    if (f.startsWith('locale/')) {
      const keys = Object.keys(doc);
      console.log('        top keys:', keys.join(', '), '| zotero keys:', Object.keys(doc.zotero || {}).join(', '));
    }
  } catch (error) {
    need(false, f, String(error.message));
  }
}

console.log('--- meta.title / meta.description present in both locales');
for (const f of ['locale/en.json', 'locale/zh.json']) {
  const doc = JSON.parse(readFileSync(path.join(pkg, f), 'utf8'));
  need(typeof doc.meta?.title === 'string' && doc.meta.title.length > 3, f + ' meta.title', JSON.stringify(doc.meta?.title));
  need(typeof doc.meta?.description === 'string' && doc.meta.description.length > 20, f + ' meta.description', '');
}

console.log('--- every t() key used in client.js exists in both dictionaries');
const client = readFileSync(path.join(pkg, 'client.js'), 'utf8');
const used = [...new Set([...client.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]))];
console.log('        used keys:', used.join(', '));
for (const f of ['locale/en.json', 'locale/zh.json']) {
  const doc = JSON.parse(readFileSync(path.join(pkg, f), 'utf8'));
  const missing = used.filter((k) => !(k in (doc.zotero || {})));
  need(missing.length === 0, f + ' covers all t() keys', 'missing: ' + missing.join(', '));
}

console.log('--- locale dictionaries are key-identical');
const en = JSON.parse(readFileSync(path.join(pkg, 'locale/en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(path.join(pkg, 'locale/zh.json'), 'utf8'));
const enKeys = Object.keys(en.zotero).sort().join('|');
const zhKeys = Object.keys(zh.zotero).sort().join('|');
need(enKeys === zhKeys, 'en/zh zotero key sets match', enKeys + ' vs ' + zhKeys);

console.log('--- DICT in client.js is key-identical to the locale files');
const dictZh = [...client.matchAll(/zh:\s*\{([\s\S]*?)\n      \}/g)][0];
const keysFromBundle = dictZh ? [...dictZh[1].matchAll(/'([^']+)':/g)].map((m) => m[1]).sort().join('|') : '';
need(keysFromBundle === zhKeys, 'bundle DICT keys == locale keys', keysFromBundle + ' vs ' + zhKeys);

console.log('--- icon');
const iconPath = path.join(pkg, 'icon.svg');
need(existsSync(iconPath), 'icon.svg exists', '');
const icon = readFileSync(iconPath);
need(icon.length > 0 && icon.length < 256 * 1024, 'icon within 256 KiB', icon.length + ' bytes');
need(/^<svg[\s>]/u.test(icon.toString('utf8').trim()), 'icon starts as <svg', '');

console.log('--- files[] covers every runtime file');
const manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
const declared = manifest.files || [];
const runtime = ['index.js', 'client.js', 'zotero.mjs', 'settings.mjs', 'operations.mjs', 'history.mjs', 'cordis.patch.yml'];
for (const f of runtime) {
  need(existsSync(path.join(pkg, f)), f + ' exists on disk', '');
  need(declared.includes(f), 'files[] lists ' + f, '');
}
for (const f of ['locale/en.json', 'locale/zh.json', 'icon.svg']) {
  need(declared.some((d) => d === f || (d.endsWith('/*.json') && f.startsWith(d.slice(0, -8)))), 'files[] covers ' + f, '');
}

console.log('--- patch references this package name');
const patch = readFileSync(path.join(pkg, 'cordis.patch.yml'), 'utf8');
need(/name:\s*dsh-zotero-sync/u.test(patch), 'patch inserts dsh-zotero-sync', '');
need(/-\s*insert:/u.test(patch), 'patch uses an insert block', '');

console.log('--- host module graph loads');
try {
  const mod = await import(pathToFileURL(path.join(pkg, 'index.js')).href);
  need(typeof mod.apply === 'function', 'exports.apply is a function', typeof mod.apply);
  need(mod.name === 'dsh-zotero-sync', 'exports.name', String(mod.name));
} catch (error) {
  need(false, 'index.js imports', String(error.message));
}

console.log('--- client bundle is syntactically a __ModuleLoader__ factory');
const bundle = readFileSync(path.join(pkg, 'client.js'), 'utf8');
need(/window\.__ModuleLoader__\.load\(\{\s*$/.test(bundle) || bundle.includes('window.__ModuleLoader__.load({'), 'opens with the loader call', '');
need(bundle.includes("id: '" + JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')).name + "'") || bundle.includes("id: 'dsh-zotero-sync'"), 'bundle id equals package name', '');
need(/factory:\s*function\s*\(\s*require\s*\)/u.test(bundle), 'factory takes require', '');
need(bundle.includes("require('react')"), 'requires react from the module table', '');
need(!/from\s+['"]@deepseek-ai/u.test(bundle), 'client imports no Harness package', '');

console.log('--- the client must connect to Zotero only on an actual upload');
// A mount-time `/zotero status` probe made every conversation reach out to Zotero even when the
// user never clicked anything. Keep the only client-side command lines the sync ones.
const clientCommands = [...bundle.matchAll(/'(\/zotero [^']*)'/g)].map((m) => m[1]);
console.log('        client command lines:', clientCommands.join(' , ') || '(none)');
need(clientCommands.every((line) => /^\/zotero sync(\s|$)/u.test(line)), 'no eager status/targets probe', clientCommands.join(', '));
need(!/run\('\/zotero status'\)/u.test(bundle), 'status is not called from a mount effect', '');
need(/exports\.apply\s*=\s*apply/u.test(bundle), 'returns apply', '');
need(/exports\.inject\s*=\s*inject/u.test(bundle), 'returns inject', '');
need(!/import\s+.*from/u.test(bundle), 'no ESM import inside the client bundle', '');
need(!/require\(['"](?!\s*react)/u.test(bundle.replace(/var React = require\('react'\);/g, '')), 'only react is required', '');

console.log('--- no @deepseek-ai imports anywhere (out-of-tree resolution is unreliable)');
for (const f of runtime.filter((x) => x.endsWith('.js') || x.endsWith('.mjs'))) {
  const text = readFileSync(path.join(pkg, f), 'utf8');
  const hits = [...text.matchAll(/from\s+['"]@deepseek-ai\/[^'"]*['"]/g)].map((m) => m[0]);
  need(hits.length === 0, f + ' free of @deepseek-ai imports', hits.join(', '));
}

console.log('--- market index is consistent with package.json and versions.json');
try {
  const manifest = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  const index = JSON.parse(readFileSync(path.join(pkg, 'market', 'index.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(path.join(pkg, 'market', 'versions.json'), 'utf8'));
  const plugin = index.plugins.find((p) => p.name === manifest.name);
  need(index.format === 1, 'index format is 1', String(index.format));
  need(Boolean(plugin), 'index lists ' + manifest.name, 'plugins: ' + index.plugins.map((p) => p.name).join(','));
  const versions = plugin.versions.map((v) => v.version);
  const registered = registry.versions.map((v) => v.version);
  need(
    versions.join(',') === registered.join(','),
    'index versions match versions.json',
    versions.join(',') + ' vs ' + registered.join(','),
  );
  // Released versions are exactly the dated CHANGELOG sections (`## [1.2.3] — 2026-01-01`);
  // `## [Unreleased]` has no date and is not a release. Every released version must be
  // installable through the index: it shipped v1.1.1 for two releases because the newest
  // entry was dropped, and a version bumped without regenerating the index is the same bug.
  let released = [];
  try {
    const changelog = readFileSync(path.join(pkg, 'CHANGELOG.md'), 'utf8');
    released = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  } catch { /* no changelog yet */ }
  need(released.length > 0, 'CHANGELOG.md lists released versions', String(released.length));
  const missing = released.filter((v) => !versions.includes(v));
  need(
    missing.length === 0,
    'index includes every released version from CHANGELOG.md',
    'missing: ' + missing.join(', ') + ' — run: node market/make-index.mjs <release commit sha>',
  );
  for (const v of plugin.versions) {
    need(/^[0-9a-f]{40}$/u.test(v.source?.commit || ''), 'version ' + v.version + ' pins a 40-hex commit', String(v.source?.commit));
    need(Number.isInteger(v.publishTimestamp) && v.publishTimestamp > 0, 'version ' + v.version + ' has a publishTimestamp', String(v.publishTimestamp));
    need(v.source?.type === 'git' && v.source?.url === plugin.repository.url, 'version ' + v.version + ' uses the repo git URL', JSON.stringify(v.source));
  }
  need(
    Boolean(index.metadata.categories[plugin.metadata.category]),
    'plugin category is declared in metadata.categories',
    plugin.metadata.category,
  );
  for (const label of plugin.metadata.labels) {
    need(Boolean(index.metadata.labels[label]), 'label ' + label + ' is declared', '');
  }
  need(index.plugins.length === 1, 'index contains only this plugin (a personal index)', String(index.plugins.length));
} catch (error) {
  need(false, 'market/index.json is valid', String(error.message));
}

console.log('--- README files exist and cross-link');
need(existsSync(path.join(pkg, 'README.md')), 'README.md exists', '');
need(existsSync(path.join(pkg, 'README.en.md')), 'README.en.md exists', '');
const readmeZh = readFileSync(path.join(pkg, 'README.md'), 'utf8');
const readmeEn = readFileSync(path.join(pkg, 'README.en.md'), 'utf8');
// The "English" link used to point at an anchor that the document never defined.
need(/README\.en\.md/.test(readmeZh), 'README.md links to README.en.md', '');
need(/README\.md/.test(readmeEn), 'README.en.md links back to README.md', '');
for (const [name, text] of [['README.md', readmeZh], ['README.en.md', readmeEn]]) {
  const broken = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)#]+)/g)]
    .map((m) => m[1])
    .filter((rel) => !existsSync(path.join(pkg, rel)));
  need(broken.length === 0, name + ' relative links resolve', broken.join(', '));
}

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
