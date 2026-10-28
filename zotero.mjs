/**
 * Zotero local Connector protocol client — pure Node, no DSH dependency.
 *
 * Every request shape here was verified against Zotero 10.0.6 by reading its own
 * bundled server sources (chrome/content/zotero/xpcom/server/{server,server_connector,saveSession}.js
 * inside D:\Zotero\app\omni.ja) and by live end-to-end calls against 127.0.0.1:23119.
 *
 * Non-obvious protocol facts encoded below:
 * 1. Zotero rejects a browser-shaped request (User-Agent starting with "Mozilla/") unless it
 *    carries X-Zotero-Connector-API-Version or Zotero-Allowed-Request. We send a plain
 *    non-browser UA plus the API-version header, which is the documented connector posture.
 * 2. /connector/saveItems MUST NOT receive `proxy: {}`. An empty object is truthy, so
 *    saveSession.js constructs `new Zotero.Proxy({})` and the save dies as a bare HTTP 500.
 *    Omitting `proxy` entirely (or sending null) is what works.
 * 3. The connector API version header must be numeric and >= Zotero's CONNECTOR_API_VERSION
 *    (3 here), otherwise versionWarning(force=true) answers 400 CONNECTOR_VERSION_OUTDATED.
 * 4. Attachment bytes go to /connector/saveAttachment as a raw body with the stream branch of
 *    _bodyData(): the Content-Type must be a non-plain-text type, and X-Metadata must carry
 *    sessionID / parentItemID (the *connector key* we chose in saveItems) / title / url.
 */

export const CONNECTOR_API_VERSION = 3;
export const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';

const PLAIN_TEXT_TYPES = new Set([
  'text/plain',
  'application/json',
  'application/x-www-form-urlencoded',
]);

/** Error carrying a machine-readable reason code plus optional user-facing detail. */
export class ZoteroError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ZoteroError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Content type Zotero will store the file as, inferred from its extension.
 * Must never land in PLAIN_TEXT_TYPES for binary files, or Zotero buffers the body
 * instead of handing the endpoint a stream.
 */
export function contentTypeFor(filename) {
  const at = String(filename || '').lastIndexOf('.');
  const ext = at < 0 ? '' : String(filename).slice(at + 1).toLowerCase();
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
      return 'text/plain;charset=utf-8';
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'doc':
      return 'application/msword';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'epub':
      return 'application/epub+zip';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'json':
      return 'application/json';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

/** True when Zotero would treat this type as buffered text rather than a stream. */
function isPlainTextType(contentType) {
  const bare = String(contentType || '').split(';')[0].trim().toLowerCase();
  return PLAIN_TEXT_TYPES.has(bare);
}

/**
 * Minimal HTTP client over Zotero's loopback server.
 * Zotero answers `HTTP/1.0` without keep-alive, so one request per connection is fine.
 */
export class ZoteroConnector {
  /**
   * @param options - { baseUrl?, timeoutMs?, fetchImpl? }
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  /** One request with connector headers; returns { status, text, json }. */
  async request(endpoint, { method = 'POST', body, contentType = 'application/json', headers = {}, search = {} } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new ZoteroError('NO_FETCH', 'global fetch is unavailable; needs Node 18+');
    }
    const url = new URL(this.baseUrl + endpoint);
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        headers: {
          'User-Agent': 'DeepSeekHarnessZoteroSync/1.0',
          'X-Zotero-Connector-API-Version': String(CONNECTOR_API_VERSION),
          ...headers,
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message)));
      if (aborted) {
        throw new ZoteroError('TIMEOUT', `Zotero did not answer ${endpoint} within ${this.timeoutMs}ms`);
      }
      throw new ZoteroError(
        'UNREACHABLE',
        'Cannot reach Zotero at ' + this.baseUrl + '. Is the Zotero desktop app running? (' + String(error && error.message ? error.message : error) + ')',
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let json;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const responseHeaders = {};
    response.headers?.forEach?.((value, name) => {
      responseHeaders[String(name).toLowerCase()] = value;
    });
    return { status: response.status, text, json, headers: responseHeaders };
  }

  /** POST a JSON body and require a 2xx, translating connector error payloads. */
  async postJson(endpoint, payload, options = {}) {
    const response = await this.request(endpoint, {
      ...options,
      body: JSON.stringify(payload ?? {}),
      contentType: 'application/json',
    });
    this.#expectOk(endpoint, response);
    return response;
  }

  /**
   * GET a Local API path (`/api/users/0/...`) and return { status, text, json, headers }.
   * Carries `Zotero-API-Version: 3`, which server_localAPI.js requires on every path except
   * the `/api/` root. Read-only: no key is ever sent because no write is ever attempted.
   */
  async getJson(path, search = {}) {
    return this.request(path, {
      method: 'GET',
      contentType: '',
      search,
      headers: { 'Zotero-API-Version': '3' },
    });
  }

  #expectOk(endpoint, response) {
    const { status, json, text } = response;
    if (status >= 200 && status < 300) return;
    const code = json && typeof json.error === 'string' ? json.error : undefined;
    if (code === 'SESSION_EXISTS') {
      throw new ZoteroError('SESSION_EXISTS', `Zotero already has a save session with that id (${endpoint})`);
    }
    if (code === 'SESSION_NOT_FOUND') {
      throw new ZoteroError(
        'SESSION_EXPIRED',
        'Zotero expired this save session (sessions last ~10 minutes). Re-run the upload.',
      );
    }
    if (code === 'CONNECTOR_VERSION_OUTDATED') {
      throw new ZoteroError(
        'VERSION_OUTDATED',
        `Zotero wants connector API version >= ${CONNECTOR_API_VERSION}.`,
      );
    }
    if (code === 'METADATA_NOT_PROVIDED') {
      throw new ZoteroError('NO_METADATA', `Zotero needs the X-Metadata header for ${endpoint}`);
    }
    if (code === 'SESSION_ID_NOT_PROVIDED') {
      throw new ZoteroError('NO_SESSION_ID', `Zotero needs a sessionID for ${endpoint}`);
    }
    if (json && json.libraryEditable === false) {
      throw new ZoteroError('READ_ONLY_LIBRARY', `The Zotero library is read-only (${endpoint}).`);
    }
    if (status === 200 && text && /not editable/i.test(text)) {
      throw new ZoteroError('FILES_READONLY', 'This Zotero library does not allow writing files.');
    }
    throw new ZoteroError(
      'HTTP_' + status,
      `Zotero answered ${status} for ${endpoint}` + (text ? `: ${text.slice(0, 200)}` : '.'),
    );
  }

  /**
   * Liveness check. GET /connector/ping answers `<body>Zotero is running</body>` and has no
   * side effects — the POST branch records the browser's active URL into Zotero's Quick Copy
   * state, which a desktop plugin has no business touching.
   * @returns {Promise<{ ok: boolean, baseUrl: string, reason?: string }>}
   */
  async ping() {
    try {
      const response = await this.request('/connector/ping', {
        method: 'GET',
        contentType: '',
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, baseUrl: this.baseUrl };
      }
      return { ok: false, baseUrl: this.baseUrl, reason: 'HTTP_' + response.status };
    } catch (error) {
      return { ok: false, baseUrl: this.baseUrl, reason: error && error.code ? error.code : String(error) };
    }
  }

  /**
   * Destination catalogue: every editable library and collection, plus the current selection.
   * @param options - { readonly includeTags?: boolean }
   */
  async getTargets(options = {}) {
    const response = await this.postJson('/connector/getSelectedCollection', {
      switchToReadableLibrary: true,
    });
    const data = response.json || {};
    const targets = Array.isArray(data.targets)
      ? data.targets.map((entry) => ({
          id: String(entry.id),
          name: String(entry.name ?? ''),
          level: Number(entry.level) || 0,
          filesEditable: entry.filesEditable !== false,
          recent: entry.recent === true,
        }))
      : [];
    return {
      libraryId: data.libraryID,
      libraryName: data.libraryName,
      libraryEditable: data.libraryEditable !== false,
      filesEditable: data.filesEditable !== false,
      // getSelectedCollection sets `id` to the collection key only when a collection is
      // selected; a null id with name == libraryName means the library root is the target.
      currentTarget: data.id != null ? 'C' + data.id : 'L' + data.libraryID,
      currentName: data.name,
      targets,
      tags: options.includeTags === true && data.tags ? data.tags : undefined,
    };
  }

  /**
   * Create the parent item, route it to `target`, then attach the file bytes.
   *
   * @param input - {
   *   sessionKey: string        unique connector key (also the save-session id)
   *   title: string
   *   file: { path: string, bytes: Uint8Array, name: string }
   *   target?: string           Zotero treeViewID ('L1' library, 'C23' collection)
   *   tags?: string[]
   *   itemType?: string         Zotero item type, default 'document'
   *   url?: string              item URL field (defaults to a file:// URL)
   *   date?: string             ISO date shown in Zotero
   *   creators?: Array<{ creatorType?: string, name?: string }>
   *   abstractNote?: string
   *   libraryCatalog?: string
   *   extra?: string
   *   DOI?: string
   *   standalone?: boolean      skip the parent item and file-save the attachment itself
   * }
   * @returns {Promise<{ itemKey: string, title: string, target: string, attachmentName: string }>}
   */
  async saveFile(input) {
    const sessionKey = String(input.sessionKey || '');
    if (!sessionKey) throw new ZoteroError('BUG', 'saveFile needs a sessionKey');
    if (!input.file || !input.file.bytes) throw new ZoteroError('BUG', 'saveFile needs file.bytes');

    const bytes = input.file.bytes;
    const name = String(input.file.name || 'file');
    const contentType = input.contentType || contentTypeFor(name);
    const sourceUrl = input.url || fileUrl(input.file.path || name);
    const title = String(input.title || name);
    const tags = Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
    let target = input.target && /^[LC]\d+$/.test(String(input.target)) ? String(input.target) : undefined;

    // updateSession reads `data.target[0]` unguarded, so every call needs a target. When the
    // caller did not choose one, ask Zotero where it would save right now and route there
    // explicitly — that also keeps the reported destination honest instead of a placeholder.
    if (!target) {
      const info = await this.getTargets();
      target = info.currentTarget;
    }

    if (input.standalone === true) {
      const response = await this.request('/connector/saveStandaloneAttachment', {
        body: bufferOf(bytes),
        contentType: safeStreamContentType(contentType),
        search: { sessionID: sessionKey },
        headers: {
          'X-Metadata': encodeMetadataHeader({ sessionID: sessionKey, title, url: sourceUrl }),
          'Content-Length': String(lenOf(bytes)),
        },
      });
      this.#expectOk('/connector/saveStandaloneAttachment', response);
      return { itemKey: sessionKey, title, target, attachmentName: name, standalone: true };
    }

    // 1. parent item. Note the deliberate absence of `proxy` — see the file header note 2.
    const item = {
      id: sessionKey,
      itemType: input.itemType || 'document',
      title,
      url: sourceUrl,
      accessDate: 'CURRENT_TIMESTAMP',
      date: input.date || new Date().toISOString().slice(0, 10),
      creators: Array.isArray(input.creators) && input.creators.length
        ? input.creators.map((c) => ({ creatorType: c.creatorType || 'author', name: c.name || 'Unknown' }))
        : [],
      tags: [],
      libraryCatalog: input.libraryCatalog || 'DeepSeek Harness',
      abstractNote: input.abstractNote || '',
      extra: input.extra || '',
    };
    if (input.DOI) item.DOI = String(input.DOI);

    await this.postJson(
      '/connector/saveItems',
      { sessionID: sessionKey, uri: sourceUrl, items: [item] },
    );

    // 2. route to the collection and apply tags. updateSession replaces the session's
    //    tag set, so this is also where tags land (saveItems was sent with tags: []).
    const sessionBody = { sessionID: sessionKey, target, tags, note: '' };
    await this.postJson('/connector/updateSession', sessionBody);

    // 3. the bytes.
    const response = await this.request('/connector/saveAttachment', {
      body: bufferOf(bytes),
      contentType: safeStreamContentType(contentType),
      search: { sessionID: sessionKey },
      headers: {
        'X-Metadata': encodeMetadataHeader({ sessionID: sessionKey, parentItemID: sessionKey, title: name, url: sourceUrl }),
        'Content-Length': String(lenOf(bytes)),
      },
    });
    this.#expectOk('/connector/saveAttachment', response);

    // 4. keep Zotero from syncing a half-finished write.
    await this.postJson('/connector/delaySync', {});

    return { itemKey: sessionKey, title, target, attachmentName: name };
  }
}

/**
 * Header values reach Zotero as latin-1 bytes, so any non-ASCII character in X-Metadata
 * (a CJK note title, for instance) can be mangled before JSON.parse sees it. Escaping every
 * non-printable-ASCII code unit to a \uXXXX pair keeps the header pure ASCII; JSON.parse
 * reassembles surrogate pairs, so titles round-trip exactly.
 */
export function encodeMetadataHeader(metadata) {
  return JSON.stringify(metadata).replace(/[^\x20-\x7e]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/**
 * A type Zotero will hand the endpoint as a *stream*.
 *
 * server.js `_bodyData()` converts the body into a JS string for text/plain,
 * application/json and x-www-form-urlencoded, and SaveAttachment then passes that string to
 * `Zotero.Attachments.importFromNetworkStream({ stream })`, which expects a stream. Any other
 * type reaches the endpoint as `request.bodyInputStream`. So a .md file keeps its real
 * `text/markdown` type (and stays previewable in Zotero), while a .txt file has to be
 * relabelled or its bytes would be corrupted on the way in.
 */
function safeStreamContentType(contentType) {
  return isPlainTextType(contentType) ? 'application/octet-stream' : contentType;
}

function bufferOf(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function lenOf(bytes) {
  return bytes.byteLength ?? bytes.length ?? 0;
}

/** file:// URL for a Windows or POSIX absolute path. */
export function fileUrl(pathLike) {
  const value = String(pathLike || '');
  if (!value) return '';
  if (/^file:\/\//i.test(value)) return value;
  const slashed = value.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(slashed)) return 'file:///' + encodeURI(slashed).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (slashed.startsWith('/')) return 'file://' + encodeURI(slashed).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return 'file://' + encodeURI(slashed);
}
