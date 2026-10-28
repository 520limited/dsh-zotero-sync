/**
 * Offline tests for library.mjs — the read-only Zotero Local API client.
 *
 * A stub fetch plays Zotero's /api/users/0/* surface, shaped exactly as
 * server_localAPI.js answers (headers, error text, Total-Results). No real Zotero is
 * contacted: this file must pass with Zotero closed.
 */
import assert from 'node:assert/strict';
import { ZoteroConnector } from '../zotero.mjs';
import { searchItems, itemDetail, itemFulltext, attachmentPath, listCollections, listTags } from '../library.mjs';

/** Minimal imitation of server_localAPI.js responses. */
function makeZoteroStub(options = {}) {
  const calls = [];
  const state = {
    localApiEnabled: options.localApiEnabled !== false,
    items: options.items || [],
    collections: options.collections || [],
    tags: options.tags || [],
    fulltext: options.fulltext || {},
    filePaths: options.filePaths || {},
  };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const search = Object.fromEntries(parsed.searchParams.entries());
    calls.push({ path, search, headers: init?.headers || {} });
    const respond = (status, body, headers = {}) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body, null, 4);
      const headerMap = Object.fromEntries(
        Object.entries({ 'Total-Results': headers['Total-Results'] ?? '', ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      return {
        status,
        json: typeof body === 'string' ? undefined : body,
        // ZoteroConnector.request calls response.text()
        async text() { return text; },
        headers: { forEach: (fn) => { for (const [name, value] of Object.entries(headerMap)) fn(value, name); } },
      };
    };
    // version gate, exactly like server_localAPI.js line 277
    const version = init?.headers?.['Zotero-API-Version'];
    if (version !== '3' && path !== '/api/') {
      return respond(501, 'API version not implemented: ' + version);
    }
    if (!state.localApiEnabled) {
      return respond(403, 'Local API is not enabled');
    }
    if (path === '/api/users/0/items/top' || path === '/api/users/0/collections/ABC12345/items/top') {
      const q = (search.q || '').toLowerCase();
      let rows = state.items;
      if (path.includes('/collections/')) rows = rows.filter((it) => it.data.collections?.includes('ABC12345'));
      if (q) rows = rows.filter((it) => (it.data.title || '').toLowerCase().includes(q));
      const limit = Number(search.limit) || 25;
      return respond(200, rows.slice(0, limit), { 'Total-Results': rows.length });
    }
    const itemMatch = path.match(/^\/api\/users\/0\/items\/([A-Z0-9]{8})(\/.*)?$/u);
    if (itemMatch) {
      const [, key, suffix] = itemMatch;
      const raw = state.items.find((it) => it.key === key);
      if (suffix === '/children') {
        if (!raw) return respond(404, 'Not found');
        return respond(200, state.items.filter((it) => it.data.parentItem === key));
      }
      if (suffix === '/fulltext') {
        if (!raw || state.fulltext[key] === undefined) return respond(404, 'Not found');
        return respond(200, state.fulltext[key]);
      }
      if (suffix === '/file/view/url') {
        const where = state.filePaths[key];
        if (!where) return respond(404, 'Not found');
        return respond(200, where, { 'Content-Type': 'text/plain' });
      }
      if (suffix === undefined && search.format) {
        if (!raw) return respond(404, 'Not found');
        return respond(200, `@article{${key}, title = {${raw.data.title}}}`, { 'Content-Type': 'text/plain' });
      }
      if (!raw) return respond(404, 'Not found');
      return respond(200, raw);
    }
    if (path === '/api/users/0/collections') return respond(200, state.collections, { 'Total-Results': state.collections.length });
    if (path === '/api/users/0/tags') return respond(200, state.tags, { 'Total-Results': state.tags.length });
    return respond(404, 'Not found');
  };
  return { connector: new ZoteroConnector({ fetchImpl }), calls, state };
}

const PARENT = {
  key: 'ABCD1234',
  data: {
    itemType: 'journalArticle',
    title: '产前胎儿超声标准切面研究',
    creators: [{ lastName: 'Wang', firstName: 'Lei' }, { lastName: 'Li', firstName: 'Na' }],
    date: '2024-03-15',
    publicationTitle: 'IEEE TMI',
    DOI: '10.1000/fake.2024',
    abstractNote: '关于标准切面的摘要。',
    tags: [{ tag: 'ultrasound' }, 'fetal'],
    collections: ['ABC12345'],
  },
};
const ATTACHMENT = {
  key: 'ATTACH01',
  data: { itemType: 'attachment', parentItem: 'ABCD1234', linkMode: 'imported_file', title: 'paper.pdf', filename: 'Wang 2024 产前胎儿超声.pdf', contentType: 'application/pdf', mtime: 1700000000000 },
};

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

{
  const { connector, calls } = makeZoteroStub({
    items: [PARENT, ATTACHMENT],
    collections: [{ key: 'ABC12345', data: { name: '超声文献', parentCollection: '' }, meta: { numItems: 1 } }],
    tags: [{ tag: 'ultrasound', meta: { numItems: 1 } }],
    fulltext: { ATTACH01: { content: '第 1 页 正文……', indexedChars: 1000, totalChars: 1000 } },
    filePaths: { ATTACH01: 'D:\\Zotero\\storage\\ATTACH01\\paper.pdf' },
  });

  // search
  const found = await searchItems(connector, { query: '超声' });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].title, '产前胎儿超声标准切面研究');
  assert.equal(found.items[0].year, '2024');
  assert.equal(found.items[0].creators[0], 'Wang, Lei');
  assert.deepEqual(found.items[0].tags, ['ultrasound', 'fetal']);
  ok('search normalizes rows (title/year/creators/tags) and reads Total-Results');

  assert.ok(calls.every((c) => c.headers['Zotero-API-Version'] === '3'), 'every GET carries Zotero-API-Version 3');
  ok('version header always sent');

  // collection-scoped search
  const inCollection = await searchItems(connector, { collection: 'ABC12345' });
  assert.equal(inCollection.total, 1);
  ok('collection-scoped search hits /collections/:key/items/top');

  // item detail with children
  const detail = await itemDetail(connector, 'ABCD1234');
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.attachments[0].key, 'ATTACH01');
  assert.equal(detail.doi, '10.1000/fake.2024');
  ok('item detail merges children attachments');

  // bibtex export passthrough
  const exported = await itemDetail(connector, 'ABCD1234', { format: 'bibtex' });
  assert.match(exported.text, /^@article\{ABCD1234/);
  ok('bibtex export returns raw text');

  // fulltext via parent key resolves best attachment
  const full = await itemFulltext(connector, 'ABCD1234');
  assert.equal(full.attachmentKey, 'ATTACH01');
  assert.equal(full.content, '第 1 页 正文……');
  ok('fulltext resolves parent → attachment → /fulltext');

  // file path
  const where = await attachmentPath(connector, 'ABCD1234');
  assert.equal(where.path, 'D:\\Zotero\\storage\\ATTACH01\\paper.pdf');
  ok('file returns the local path from /file/view/url');

  // collections & tags
  const cols = await listCollections(connector);
  assert.equal(cols.collections[0].name, '超声文献');
  const tags = await listTags(connector, { query: 'ult' });
  assert.equal(tags.tags[0].tag, 'ultrasound');
  ok('collections & tags lists');
}

{
  // local API disabled → actionable error
  const { connector } = makeZoteroStub({ localApiEnabled: false });
  await assert.rejects(() => searchItems(connector, {}), /允许此计算机上的其他应用程序与 Zotero 通讯/);
  ok('LOCAL_API_DISABLED error names the exact preference');
}

{
  // no fulltext cache → NO_FULLTEXT
  const { connector } = makeZoteroStub({ items: [PARENT, ATTACHMENT] });
  await assert.rejects(
    () => itemFulltext(connector, 'ABCD1234'),
    (error) => error.code === 'NO_FULLTEXT',
  );
  ok('missing fulltext cache reports NO_FULLTEXT');
}

{
  // bad key rejected before any network call
  const { connector, calls } = makeZoteroStub({});
  await assert.rejects(() => itemDetail(connector, 'short'), /8 位/);
  assert.equal(calls.length, 0);
  ok('malformed key fails fast without a request');
}

console.log(`\nALL ${passed} LIBRARY CHECKS PASSED`);
