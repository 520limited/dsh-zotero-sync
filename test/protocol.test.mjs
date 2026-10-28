/**
 * Protocol test for zotero.mjs, run against a recorded stub fetch — never a real Zotero.
 *
 * Each assertion protects a fact that was discovered by reading Zotero 10.0.6's own server
 * sources or by hitting a live 500, so a regression here means the plugin silently stops
 * working against a Zotero update.
 */
import {
  ZoteroConnector,
  ZoteroError,
  contentTypeFor,
  encodeMetadataHeader,
  fileUrl,
  CONNECTOR_API_VERSION,
} from '../zotero.mjs';

let fail = 0;
const need = (cond, label, extra) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (cond ? '' : '  <- ' + extra));
  if (!cond) fail++;
};

/** Records requests and answers with canned responses, honoring the caller's abort signal. */
function recorder(handler) {
  const seen = [];
  const fetchImpl = (url, init = {}) => {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[String(k).toLowerCase()] = String(v);
    seen.push({ url: String(url), method: init.method, headers, body: init.body, signal: init.signal });
    const answer = Promise.resolve().then(() => handler(String(url), headers, init));
    if (!init.signal) return answer;
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) return reject(abortError());
      init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      answer.then(resolve, reject);
    });
  };
  return { seen, fetchImpl };
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

const ok = (body = '') => ({
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => body,
});

console.log('--- content types');
need(contentTypeFor('a.md') === 'text/markdown', 'md keeps text/markdown', contentTypeFor('a.md'));
need(contentTypeFor('A.MD') === 'text/markdown', 'extension is case-insensitive', contentTypeFor('A.MD'));
need(contentTypeFor('a.txt').startsWith('text/plain'), 'txt is text/plain', contentTypeFor('a.txt'));
need(contentTypeFor('a.pdf') === 'application/pdf', 'pdf', contentTypeFor('a.pdf'));
need(contentTypeFor('noext') === 'application/octet-stream', 'unknown falls back', contentTypeFor('noext'));

console.log('--- X-Metadata must be pure ASCII (headers cross as latin-1)');
const meta = encodeMetadataHeader({ title: '中文笔记-🎉 与 "quotes"', url: 'file:///D:/a.md' });
need(!/[^\x20-\x7e]/u.test(meta), 'header value is printable ASCII only', JSON.stringify(meta));
need(JSON.parse(meta).title === '中文笔记-🎉 与 "quotes"', 'CJK and emoji round-trip', JSON.parse(meta).title);
need(JSON.parse(meta).url === 'file:///D:/a.md', 'ascii field survives', JSON.parse(meta).url);

console.log('--- fileUrl');
need(fileUrl('D:\\a b\\c#d.md') === 'file:///D:/a%20b/c%23d.md', 'windows path', fileUrl('D:\\a b\\c#d.md'));
need(fileUrl('/tmp/x.md') === 'file:///tmp/x.md', 'posix path', fileUrl('/tmp/x.md'));
need(fileUrl('file:///already.md') === 'file:///already.md', 'already a url', fileUrl('file:///already.md'));

console.log('--- ping uses GET and does not mutate Zotero state');
{
  const { seen, fetchImpl } = recorder((url) => ({
    status: 200,
    headers: new Headers(),
    text: async () => '<!DOCTYPE html><html><body>Zotero is running</body></html>',
  }));
  const z = new ZoteroConnector({ fetchImpl });
  const alive = await z.ping();
  need(alive.ok === true, 'ping ok', JSON.stringify(alive));
  need(seen[0].method === 'GET', 'ping is GET (POST would set QuickCopy lastActiveURL)', seen[0].method);
  need(seen[0].headers['x-zotero-connector-api-version'] === String(CONNECTOR_API_VERSION), 'api version header sent', seen[0].headers['x-zotero-connector-api-version']);
  need(!String(seen[0].headers['user-agent']).startsWith('Mozilla/'), 'UA is not browser-shaped (browser UA is blocked without a real origin)', seen[0].headers['user-agent']);
}

console.log('--- getTargets maps the connector payload');
{
  const payload = JSON.stringify({
    libraryID: 1,
    libraryName: '我的文库',
    libraryEditable: true,
    filesEditable: true,
    id: 23,
    name: '论文',
    targets: [
      { id: 'L1', name: '我的文库', filesEditable: true, level: 0 },
      { id: 'C23', name: '论文', filesEditable: true, level: 1, recent: true },
    ],
  });
  const { fetchImpl } = recorder(() => ok(payload));
  const info = await new ZoteroConnector({ fetchImpl }).getTargets();
  need(info.libraryName === '我的文库', 'library name', info.libraryName);
  need(info.currentTarget === 'C23', 'selected collection maps to C23', info.currentTarget);
  need(info.targets.length === 2 && info.targets[1].level === 1, 'targets mapped', JSON.stringify(info.targets));
  need(info.filesEditable === true, 'filesEditable read', String(info.filesEditable));
}

console.log('--- library root maps to L<id> when no collection is selected');
{
  const payload = JSON.stringify({
    libraryID: 1, libraryName: 'My Library', libraryEditable: true, filesEditable: true,
    id: null, name: 'My Library',
    targets: [{ id: 'L1', name: 'My Library', filesEditable: true, level: 0 }],
  });
  const { fetchImpl } = recorder(() => ok(payload));
  const info = await new ZoteroConnector({ fetchImpl }).getTargets();
  need(info.currentTarget === 'L1', 'null collection id maps to the library', info.currentTarget);
}

console.log('--- saveFile must NEVER send a proxy field');
{
  const { seen, fetchImpl } = recorder((url) => {
    if (url.includes('/connector/saveItems')) return { status: 201, headers: new Headers(), text: async () => '' };
    if (url.includes('/updateSession')) return ok('{}');
    if (url.includes('/saveAttachment')) return { status: 201, headers: new Headers(), text: async () => '' };
    if (url.includes('/getSelectedCollection')) {
      return ok(JSON.stringify({ libraryID: 1, libraryName: 'L', libraryEditable: true, filesEditable: true, id: null, targets: [{ id: 'L1', name: 'L', level: 0 }] }));
    }
    return ok('{}');
  });
  const z = new ZoteroConnector({ fetchImpl });
  const bytes = new TextEncoder().encode('# hi 中文\n');
  const saved = await z.saveFile({
    sessionKey: 'k1',
    title: '标题',
    file: { path: 'D:\\tmp\\note.md', bytes, name: 'note.md' },
    target: 'C5',
    tags: ['a', 'b'],
  });
  const saveItems = seen.find((r) => r.url.includes('/saveItems'));
  const body = JSON.parse(saveItems.body);
  need(!('proxy' in body), 'saveItems omits proxy — `proxy: {}` makes Zotero throw a bare 500', JSON.stringify(Object.keys(body)));
  need(body.items[0].itemType === 'document', 'default item type', body.items[0].itemType);
  need(body.items[0].accessDate === 'CURRENT_TIMESTAMP', 'accessDate sentinel', body.items[0].accessDate);
  need(body.items[0].id === 'k1', 'connector key is our id', body.items[0].id);

  const upd = seen.find((r) => r.url.includes('/updateSession'));
  const updBody = JSON.parse(upd.body);
  need(updBody.target === 'C5', 'updateSession carries an explicit target (data.target[0] is unguarded)', JSON.stringify(updBody));
  need(JSON.stringify(updBody.tags) === '["a","b"]', 'tags land via updateSession', JSON.stringify(updBody.tags));
  need(Array.isArray(body.items[0].tags) && body.items[0].tags.length === 0, 'saveItems sends no tags', JSON.stringify(body.items[0].tags));

  const att = seen.find((r) => r.url.includes('/saveAttachment'));
  need(att.headers['content-type'] === 'text/markdown', 'attachment keeps its real type', att.headers['content-type']);
  need(att.headers['content-length'] === String(bytes.length), 'Content-Length matches the body', att.headers['content-length'] + ' vs ' + bytes.length);
  need(att.headers['x-metadata'] === encodeMetadataHeader({ sessionID: 'k1', parentItemID: 'k1', title: 'note.md', url: fileUrl('D:\\tmp\\note.md') }), 'X-Metadata shape', att.headers['x-metadata']);
  need(!/[^\x20-\x7e]/u.test(att.headers['x-metadata']), 'X-Metadata is ascii-only', att.headers['x-metadata']);
  need(att.url.includes('sessionID=k1'), 'session id also travels as a query param', att.url);
  need(saved.target === 'C5' && saved.attachmentName === 'note.md', 'result reports the real destination', JSON.stringify(saved));
  const delayed = seen.some((r) => r.url.includes('/delaySync'));
  need(delayed, 'delaySync is called after a successful save', '');
}

console.log('--- a .txt attachment is relabelled so Zotero streams instead of buffering');
{
  const { seen, fetchImpl } = recorder((url) => {
    if (url.includes('/getSelectedCollection')) return ok(JSON.stringify({ libraryID: 1, libraryName: 'L', libraryEditable: true, filesEditable: true, id: null, targets: [{ id: 'L1', name: 'L', level: 0 }] }));
    return { status: 201, headers: new Headers(), text: async () => '' };
  });
  await new ZoteroConnector({ fetchImpl }).saveFile({
    sessionKey: 'k2',
    title: 'plain',
    file: { path: 'C:\\a.txt', bytes: new TextEncoder().encode('hello'), name: 'a.txt' },
  });
  const att = seen.find((r) => r.url.includes('/saveAttachment'));
  need(att.headers['content-type'] === 'application/octet-stream',
    'text/plain would be buffered into a string and break importFromNetworkStream', att.headers['content-type']);
}

console.log('--- target resolution falls back to Zotero\'s current selection');
{
  const { seen, fetchImpl } = recorder((url) => {
    if (url.includes('/getSelectedCollection')) {
      return ok(JSON.stringify({ libraryID: 1, libraryName: 'L', libraryEditable: true, filesEditable: true, id: 42, name: 'C42', targets: [{ id: 'C42', name: 'C42', level: 1 }] }));
    }
    return { status: 201, headers: new Headers(), text: async () => '' };
  });
  const saved = await new ZoteroConnector({ fetchImpl }).saveFile({
    sessionKey: 'k3', title: 't', file: { path: 'a.md', bytes: new Uint8Array([1]), name: 'a.md' },
  });
  const asked = seen.some((r) => r.url.includes('/getSelectedCollection'));
  need(asked && saved.target === 'C42', 'no explicit target asks Zotero and reports the real place', JSON.stringify(saved));
}

console.log('--- error mapping');
{
  const z = new ZoteroConnector({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  let code = '';
  try { await z.getTargets(); } catch (e) { code = e.code; }
  need(code === 'UNREACHABLE', 'a refused connection maps to UNREACHABLE', code);
  const alive = await z.ping();
  need(alive.ok === false && alive.reason === 'UNREACHABLE', 'ping never throws', JSON.stringify(alive));

  const { fetchImpl } = recorder(() => ({ status: 400, headers: new Headers(), text: async () => JSON.stringify({ error: 'SESSION_NOT_FOUND' }) }));
  let err = null;
  try { await new ZoteroConnector({ fetchImpl }).postJson('/connector/updateSession', { sessionID: 'x' }); } catch (e) { err = e; }
  need(err instanceof ZoteroError && err.code === 'SESSION_EXPIRED', 'SESSION_NOT_FOUND maps to a retryable code', String(err && err.code));

  const readOnly = recorder(() => ({ status: 500, headers: new Headers(), text: async () => JSON.stringify({ libraryEditable: false }) }));
  let err2 = null;
  try { await new ZoteroConnector({ fetchImpl: readOnly.fetchImpl }).postJson('/connector/saveItems', {}); } catch (e) { err2 = e; }
  need(err2 && err2.code === 'READ_ONLY_LIBRARY', 'read-only library is named', String(err2 && err2.code));

  // Never answers: the connector's own AbortController is what must end this call, and the
  // recorder wrapper turns that abort into an AbortError the way a real fetch would.
  const timeout = recorder(() => new Promise(() => {}));
  const slow = new ZoteroConnector({ fetchImpl: timeout.fetchImpl, timeoutMs: 30 });
  let err3 = null;
  try { await slow.postJson('/connector/ping', {}); } catch (e) { err3 = e; }
  need(err3 && err3.code === 'TIMEOUT', 'a hung Zotero hits the timeout', String(err3 && err3.code));
}

console.log('--- an invalid target string is ignored rather than crashing Zotero');
{
  const { seen, fetchImpl } = recorder((url) => {
    if (url.includes('/getSelectedCollection')) return ok(JSON.stringify({ libraryID: 1, libraryName: 'L', libraryEditable: true, filesEditable: true, id: null, targets: [{ id: 'L1', name: 'L', level: 0 }] }));
    return { status: 201, headers: new Headers(), text: async () => '' };
  });
  const saved = await new ZoteroConnector({ fetchImpl }).saveFile({
    sessionKey: 'k9', title: 't', file: { path: 'a.md', bytes: new Uint8Array([1]), name: 'a.md' }, target: 'Cabc',
  });
  need(saved.target === 'L1', 'garbage target falls back to the live selection', JSON.stringify(saved));
}

console.log('--- a 500 body is quoted into the message');
{
  const { fetchImpl } = recorder(() => ({ status: 500, headers: new Headers(), text: async () => 'boom' }));
  let err = null;
  try { await new ZoteroConnector({ fetchImpl }).postJson('/connector/saveItems', {}); } catch (e) { err = e; }
  need(err && err.code === 'HTTP_500' && /boom/u.test(err.message), 'HTTP 500 keeps its body', String(err && err.message));
}

console.log(fail === 0 ? '\nALL PROTOCOL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
