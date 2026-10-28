/**
 * LIVE end-to-end test. Unlike the other suites, this one talks to your REAL Zotero and
 * creates a real item in your library, so it is opt-in:
 *
 *   Zotero: Settings > General must be running, and set ZTS_LIVE=1
 *   node test/live-sync.test.mjs        # skips, writes nothing
 *   ZTS_LIVE=1 node test/live-sync.test.mjs
 *
 * It creates a small markdown note, registers it as presented, syncs it, then re-syncs to
 * prove hash dedupe. Delete the created item from Zotero afterwards if you are checking by hand.
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.ZTS_LIVE !== '1') {
  console.log('live-sync.test: SKIPPED (this test writes into your real Zotero library).');
  console.log('Run it deliberately with ZTS_LIVE=1.');
  process.exit(0);
}

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

const dir = path.join(
  process.env.TEMP || os.tmpdir(),
  'zts-live-' + Date.now().toString(36),
);
// Keep the plugin's settings/history out of the real profile directory: this run must leave no
// stored target or dedupe record behind.
process.env.DSH_PROFILE_DIR = dir;
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
