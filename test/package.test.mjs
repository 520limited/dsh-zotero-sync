import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = 'D:\\PostGra\\DSH_workspace\\dsh-zotero-sync';
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

console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
