/**
 * Verify the live group test by finding the real item key via the title, then listing its
 * children. Also prints a ready-to-use cleanup hint.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.resolve(import.meta.dirname, '..');
const { ZoteroConnector } = await import(pathToFileURL(path.join(pkg, 'zotero.mjs')).href);

const z = new ZoteroConnector({ timeoutMs: 20000 });
const marker = process.argv[2] || '一次回答多文件合并';

const search = await z.getJson('/api/users/0/items/top', { q: marker, qmode: 'titleCreatorYear', limit: 20 });
const rows = Array.isArray(search.json) ? search.json : [];
console.log('search status:', search.status, 'hits:', rows.length);

let found = null;
for (const row of rows) {
  const d = row.data || row;
  if (String(d.title || '').includes(marker)) { found = d; break; }
}
if (!found) {
  console.log('NOT FOUND — title:', marker);
  process.exit(1);
}

console.log('\nPARENT ITEM');
console.log('  key:', found.key);
console.log('  itemType:', found.itemType);
console.log('  title:', found.title);

const kids = await z.getJson(`/api/users/0/items/${found.key}/children`, {});
const list = Array.isArray(kids.json) ? kids.json : [];
console.log('\nCHILDREN:', list.length);
for (const c of list) {
  const d = c.data || c;
  console.log('   ·', d.itemType, '|', d.title || '(no title)', '|', d.contentType || '');
}

const atts = list.filter((c) => (c.data || c).itemType === 'attachment');
console.log('\nRESULT:', atts.length === 3 ? 'PASS — 1 entry with 3 attachments' : `MISMATCH — ${atts.length} attachments`);
console.log('CLEANUP_KEY=' + found.key);
