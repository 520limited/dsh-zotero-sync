/**
 * Live e2e: run the plugin's own sync action against the real Zotero on 127.0.0.1:23119.
 * Creates a small markdown note, registers it as presented, syncs, then re-syncs to prove
 * hash dedupe. Run with Zotero open:  node test/live-sync.test.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href;
const listeners = new Map();
const tools = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(deps, fn) { fn({ tools: { register: (t) => tools.set(t.name, t) }, commands: { register: (c) => {} } }); },
  on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
  workingDirectory: null,
};
const { apply } = await import(root);
apply(ctx, { source: 'session', scope: 'docs', target: '' });
const emit = (event, ...args) => (listeners.get(event) || []).forEach((f) => f(...args));

const dir = path.join(os.homedir(), '.dsh', 'plugin-data', 'dsh-zotero-sync', 'e2e-tmp');
mkdirSync(dir, { recursive: true });
const note = path.join(dir, `zts-e2e-${Date.now()}.md`);
writeFileSync(note, `# dsh-zotero-sync e2e\n\n上传时间：${new Date().toISOString()}\n\n中文 + emoji 🎉 往返验证。\n`);

const agent = { session: { id: 'e2e', meta: { cwd: dir } } };
emit('session/event', agent.session, { type: 'deliverables/presented', data: { turn: 1, callId: 'x', files: [{ path: note }] } });

const tool = tools.get('zotero_sync');
const signal = new AbortController().signal;

const status = await tool.execute({ action: 'status' }, { agent, signal });
assert.ok(status.ok, 'zotero reachable: ' + status.message);

const first = await tool.execute({ action: 'sync', title: 'DSH e2e 测试笔记 🎉' }, { agent, signal });
console.log('sync#1:', first.message);
assert.equal(first.ok, true, 'first sync succeeded');
const r1 = first.results[0];
assert.ok(!r1.error && !r1.skipped, 'uploaded, not skipped');
assert.match(r1.target, /^[LC]\d+$/u, 'target reported');

const second = await tool.execute({ action: 'sync' }, { agent, signal });
console.log('sync#2:', second.message);
assert.ok(second.results[0].skipped, 'second sync dedupes by hash');

console.log('live-sync.test: PASS | item', JSON.stringify({ title: r1.title, target: r1.target, attachment: r1.attachment }));
console.log('note file kept for manual check in Zotero:', note);
