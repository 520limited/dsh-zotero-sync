/**
 * Live end-to-end check for group mode against a REAL running Zotero.
 *
 * Creates one throwaway entry in the user's library holding several attachments, then reports
 * what Zotero actually stored. It does not delete anything; the caller removes the test entry
 * afterwards (or the user can).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.resolve(import.meta.dirname, '..');
const { ZoteroConnector } = await import(pathToFileURL(path.join(pkg, 'zotero.mjs')).href);
const { syncMany } = await import(pathToFileURL(path.join(pkg, 'operations.mjs')).href);

process.env.DSH_PROFILE_DIR = mkdtempSync(path.join(os.tmpdir(), 'zts-live-'));

const z = new ZoteroConnector({ timeoutMs: 20000 });
const ping = await z.ping();
console.log('ping:', JSON.stringify(ping));
if (!ping.ok) {
  console.log('Zotero connector unreachable; skipping live test.');
  process.exit(0);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'zts-live-files-'));
const files = ['甲-笔记.md', '乙-附件.txt', '丙-第三份.md'];
for (const f of files) writeFileSync(path.join(dir, f), `# ${f}\n分组测试内容 ${Date.now()}\n`);

const candidates = files.map((f) => {
  const p = path.join(dir, f);
  return { path: p, name: f, size: 20, mtimeMs: Date.now() };
});

console.log('\nuploading', candidates.length, 'files in ONE group...');
const outcomes = await syncMany({
  zot: z,
  candidates,
  target: 'C1',
  tags: ['DSH分组测试'],
  title: '【测试】一次回答多文件合并 ' + new Date().toISOString().slice(0, 19),
  grouped: true,
  force: true,
});

for (const o of outcomes) console.log(' ', o.error ? 'ERROR ' + o.error : `OK ${o.name} -> ${o.attachment} (group ${o.groupKey})`);

const ok = outcomes.filter((o) => !o.error);
if (!ok.length) { console.log('upload failed'); process.exit(1); }
const key = ok[0].groupKey;
console.log('\ngroup item key:', key);

// Ask Zotero what it really stored.
const detail = await z.getJson(`/api/users/0/items/${key}`, {});
console.log('item JSON status:', detail.status);
const item = detail.json?.data || detail.json;
console.log('  title:', item?.title);
console.log('  itemType:', item?.itemType);

const children = await z.getJson(`/api/users/0/items/${key}/children`, {});
console.log('children status:', children.status);
const list = Array.isArray(children.json) ? children.json : [];
console.log('  attachment count:', list.length);
for (const c of list) {
  const d = c.data || c;
  console.log('   ·', d.itemType, '|', d.title, '|', d.contentType);
}

const expected = ok.length;
console.log(`\nRESULT: ${list.length} attachments under 1 item — ${list.length === expected ? 'PASS' : 'MISMATCH (expected ' + expected + ')'}`);
console.log('CLEANUP_KEY=' + key + ' LIBRARY=C1');
