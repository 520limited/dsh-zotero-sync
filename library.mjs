/**
 * Read-only access to the local Zotero library via Zotero's built-in Local API
 * (`/api/users/0/...` on 127.0.0.1:23119).
 *
 * Protocol facts verified against Zotero 10.0.6 sources (chrome/content/zotero/xpcom/server/
 * server_localAPI.js inside omni.ja), extracted to .zotero-probe during development:
 *
 * 1. Every request needs `Zotero-API-Version: 3` (header or ?v=3). Any other version answers
 *    501 "API version not implemented", except on the no-op `/api/` root.
 * 2. userID must be 0 (or the logged-in user's id); anything else answers 400. 0 always works.
 * 3. GET is unauthenticated. Writes (POST/PUT/PATCH/DELETE) require a key from
 *    /api/local/authorize — we never write, so we never need one.
 * 4. The whole API is behind pref `extensions.zotero.httpServer.localAPI.enabled`, which is
 *    FALSE by default. When it is off the connector server still runs, but /api/* answers 403
 *    "Local API is not enabled". The user turns it on in Zotero Preferences → Advanced →
 *    "Allow other applications on this computer to communicate with Zotero"
 *    (zh-CN: 允许此计算机上的其他应用程序与 Zotero 通讯).
 * 5. `GET /api/users/0/items/:key/file` answers 302 with a Location to a file: URL, while
 *    `.../file/view/url` answers 200 text/plain whose body IS the local path — easier to use
 *    from a plugin, no redirect following needed.
 * 6. `GET /api/users/0/items/:key/fulltext` returns { content, indexedChars, totalChars, ... }
 *    for file attachments whose MIME type has a full-text cache (PDF and friends). 404 when
 *    the item is not a file attachment or has no cached text.
 * 7. Search parameters mirror the web API: q, qmode (includes|startsWith), tag, itemType
 *    (a type or `-attachment`), limit, start, sort (dateModified|dateAdded|creator|title|...),
 *    direction (asc|desc), and `format=bibtex|ris|csljson|...` for export payloads.
 * 8. List answers carry a `Total-Results` header — the honest count for pagination.
 */

const EXPORT_FORMATS = new Set([
  'bibtex', 'biblatex', 'csljson', 'ris', 'csv', 'mods', 'refer', 'tei', 'wikipedia',
]);

/** Reasons a library read can fail, as machine-readable codes. */
export const LIBRARY_ERROR_CODES = new Set([
  'LOCAL_API_DISABLED', 'NOT_FOUND', 'NO_FULLTEXT', 'NOT_FILE_ATTACHMENT', 'HTTP_4xx', 'HTTP_5xx',
]);

/**
 * One search/list page. Normalizes Zotero's API JSON into flat rows an agent can quote.
 * @param {import('./zotero.mjs').ZoteroConnector} zot
 * @param options - {
 *   query?, tag?, itemType?, collection?, search?,    // filters
 *   limit?, start?, sort?, direction?,                // paging/ordering
 * }
 */
export async function searchItems(zot, options = {}) {
  const search = buildSearch(options);
  const path = options.collection
    ? `/api/users/0/collections/${encodeURIComponent(options.collection)}/items/top`
    : '/api/users/0/items/top';
  const response = await zot.getJson(path, search);
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status === 404) return { total: 0, items: [] };
  if (response.status >= 400) throw libraryError(response);
  const total = Number(response.headers['total-results']) || (response.json || []).length;
  return { total, items: (response.json || []).map(normalizeItem) };
}

/**
 * One item's full metadata, with its attachments and notes attached.
 * @param options - { format?: 'bibtex'|'ris'|'csljson'|... } returns the raw export text instead.
 */
export async function itemDetail(zot, key, options = {}) {
  const itemKey = requireKey(key);
  if (options.format) {
    if (!EXPORT_FORMATS.has(options.format)) {
      const error = new Error(`不支持的导出格式 ${options.format}。可用：${[...EXPORT_FORMATS].join(', ')}`);
      error.code = 'BAD_FORMAT';
      throw error;
    }
    const response = await zot.getJson(`/api/users/0/items/${itemKey}`, { format: options.format });
    if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
    if (response.status >= 400) throw libraryError(response);
    return { itemKey, format: options.format, text: response.text };
  }
  const response = await zot.getJson(`/api/users/0/items/${itemKey}`);
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status >= 400) throw libraryError(response);
  const detail = normalizeItem(response.json, { full: true });
  const childrenResponse = await zot.getJson(`/api/users/0/items/${itemKey}/children`);
  if (childrenResponse.status >= 200 && childrenResponse.status < 300) {
    const children = childrenResponse.json || [];
    detail.attachments = children.filter((c) => c.data?.itemType === 'attachment').map(normalizeItem);
    detail.notes = children.filter((c) => c.data?.itemType === 'note').map((c) => ({
      key: c.key,
      title: firstLine(c.data?.note || ''),
    }));
  }
  return detail;
}

/**
 * The extracted text of an item's best file attachment. Accepts either the parent item key
 * (picks its imported-file attachment automatically) or the attachment key itself.
 */
export async function itemFulltext(zot, key) {
  const itemKey = requireKey(key);
  const attachment = await bestAttachment(zot, itemKey);
  const response = await zot.getJson(`/api/users/0/items/${attachment.key}/fulltext`);
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status === 404) {
    const error = new Error(`条目 ${attachment.key}（${attachment.title}）没有可提取的全文缓存（仅 PDF 等可索引类型有）。`);
    error.code = 'NO_FULLTEXT';
    throw error;
  }
  if (response.status >= 400) throw libraryError(response);
  const data = response.json || {};
  return {
    attachmentKey: attachment.key,
    attachmentTitle: attachment.title,
    contentType: attachment.contentType || '',
    content: String(data.content || ''),
    indexedChars: data.indexedChars,
    totalChars: data.totalChars,
  };
}

/**
 * The absolute local path of an item's best file attachment (Zotero storage), so the agent
 * can read the PDF itself. Accepts a parent item key or an attachment key.
 *
 * `GET .../file/view/url` answers 200 with a `file:///D:/...` URL (percent-encoded), not a
 * plain path — convert it to a native Windows/POSIX path and decode the escapes.
 */
export async function attachmentPath(zot, key) {
  const itemKey = requireKey(key);
  const attachment = await bestAttachment(zot, itemKey);
  const response = await zot.getJson(`/api/users/0/items/${attachment.key}/file/view/url`);
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status >= 400) throw libraryError(response);
  const path = localPathFromFileUrl(String(response.text || '').trim());
  if (!path) {
    const error = new Error(`Zotero 未返回 ${attachment.key} 的本地文件路径。`);
    error.code = 'HTTP_4xx';
    throw error;
  }
  return { attachmentKey: attachment.key, title: attachment.title, contentType: attachment.contentType, path };
}

/** `file:///D:/a%20b.pdf` → `D:\a b.pdf`; `file:///home/x/a.pdf` → `/home/x/a.pdf`. */
export function localPathFromFileUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^file:\/\//iu.test(text)) return text; // already a plain path
  let decoded;
  try {
    decoded = decodeURI(text);
  } catch {
    decoded = text;
  }
  const slashed = decoded.replace(/^file:\/\//iu, '');
  // Windows drive: file:///D:/x → /D:/x → D:/x
  const drive = slashed.match(/^\/([a-zA-Z]:)(\/.*)$/u);
  if (drive) return drive[1] + drive[2].replace(/\//gu, '\\');
  return slashed;
}

/** Every collection, shallow (api returns a flat list with parentCollection keys). */
export async function listCollections(zot) {
  const response = await zot.getJson('/api/users/0/collections', { limit: 250 });
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status >= 400) throw libraryError(response);
  const rows = (response.json || []).map((c) => ({
    key: c.key,
    name: c.data?.name || '',
    parent: c.data?.parentCollection || '',
    itemCount: c.meta?.numItems,
  }));
  return { total: Number(response.headers['total-results']) || rows.length, collections: rows };
}

/** All tags, optionally filtered by q. */
export async function listTags(zot, options = {}) {
  const search = { limit: Math.min(Number(options.limit) || 100, 250) };
  if (options.query) search.q = options.query;
  const response = await zot.getJson('/api/users/0/tags', search);
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status >= 400) throw libraryError(response);
  const rows = (response.json || []).map((t) => ({ tag: t.tag, itemCount: t.meta?.numItems }));
  return { total: Number(response.headers['total-results']) || rows.length, tags: rows };
}

/* ── helpers ── */

function buildSearch(options) {
  const search = {
    limit: Math.min(Math.max(Number(options.limit) || 25, 1), 100),
    start: Math.max(Number(options.start) || 0, 0),
    sort: options.sort || 'dateModified',
    direction: options.direction === 'asc' ? 'asc' : 'desc',
  };
  if (options.query) search.q = options.query;
  if (options.tag) search.tag = options.tag;
  if (options.itemType) search.itemType = options.itemType;
  if (options.search) Object.assign(search, options.search);
  return search;
}

/** Resolve a parent item to its best file attachment (imported file first, largest wins). */
async function bestAttachment(zot, itemKey) {
  const response = await zot.getJson(`/api/users/0/items/${itemKey}`);
  if (response.status === 403) throw libraryError(response, 'LOCAL_API_DISABLED');
  if (response.status >= 400) throw libraryError(response);
  const data = response.json?.data || {};
  if (data.itemType === 'attachment') return normalizeItem(response.json);
  const childrenResponse = await zot.getJson(`/api/users/0/items/${itemKey}/children`);
  if (childrenResponse.status >= 400) throw libraryError(childrenResponse);
  const files = (childrenResponse.json || [])
    .filter((c) => c.data?.itemType === 'attachment' && (c.data.linkMode === 'imported_file' || c.data.linkMode === 'imported_url'));
  if (!files.length) {
    const error = new Error(`条目 ${itemKey} 没有可访问的附件文件（链接型附件不算）。`);
    error.code = 'NOT_FILE_ATTACHMENT';
    throw error;
  }
  files.sort((a, b) => Number(b.data?.mtime || 0) - Number(a.data?.mtime || 0));
  return normalizeItem(files[0]);
}

function normalizeItem(raw, { full = false } = {}) {
  const data = raw?.data || {};
  const creators = Array.isArray(data.creators) ? data.creators : [];
  const item = {
    key: raw?.key || data.key || '',
    itemType: data.itemType || '',
    title: data.title || data.name || (data.itemType === 'note' ? firstLine(data.note) : '') || '',
    creators: creators.map(creatorLabel).filter(Boolean),
    year: yearOf(data.date),
    date: data.date || '',
    tags: (Array.isArray(data.tags) ? data.tags : []).map((t) => (typeof t === 'string' ? t : t?.tag)).filter(Boolean),
  };
  if (data.DOI) item.doi = data.DOI;
  if (data.url) item.url = data.url;
  if (data.publicationTitle) item.journal = data.publicationTitle;
  if (data.abstractNote) item.abstract = data.abstractNote;
  if (data.contentType) item.contentType = data.contentType;
  if (data.filename) item.filename = data.filename;
  if (data.linkMode) item.linkMode = data.linkMode;
  if (full) {
    item.language = data.language || '';
    item.pages = data.pages || '';
    item.volume = data.volume || '';
    item.issue = data.issue || '';
    item.extra = data.extra || '';
    item.collections = Array.isArray(data.collections) ? data.collections : [];
    item.raw = data;
  }
  return item;
}

function creatorLabel(creator) {
  if (!creator) return '';
  if (creator.name) return creator.name;
  const given = String(creator.firstName || '').trim();
  const last = String(creator.lastName || '').trim();
  return [last, given].filter(Boolean).join(', ');
}

function yearOf(date) {
  const text = String(date || '');
  const match = text.match(/\d{4}/u);
  return match ? match[0] : '';
}

function firstLine(text) {
  const value = String(text || '').replace(/<[^>]+>/gu, ' ').trim();
  return value.split(/\r?\n/u)[0].slice(0, 200);
}

function requireKey(key) {
  const value = String(key || '').trim();
  if (!/^[A-Z0-9]{8}$/u.test(value)) {
    const error = new Error(`需要 8 位 Zotero 条目 key（在检索结果里），收到 "${value}"。`);
    error.code = 'BAD_KEY';
    throw error;
  }
  return value;
}

function libraryError(response, code) {
  const detail = String(response.text || '').slice(0, 200);
  const error = code === 'LOCAL_API_DISABLED'
    ? new Error('Zotero 的本地 API 未开启。请在 Zotero 设置 → 高级 → 杂项，勾选「允许此计算机上的其他应用程序与 Zotero 通讯」，然后重试。')
    : new Error(`Zotero 本地 API 返回 ${response.status}${detail ? `: ${detail}` : ''}`);
  error.code = code || (response.status < 500 ? 'HTTP_4xx' : 'HTTP_5xx');
  if (code === 'LOCAL_API_DISABLED') error.status = response.status;
  return error;
}

/** Compact one-line rendering used by command output. */
export function formatItemRow(item) {
  const who = item.creators.length ? item.creators[0] + (item.creators.length > 1 ? ' 等' : '') : '—';
  const where = item.journal || item.contentType || item.itemType;
  return `${item.key}  ${item.year || '————'}  ${who}  《${item.title}》  [${where}]`;
}

export { EXPORT_FORMATS };
