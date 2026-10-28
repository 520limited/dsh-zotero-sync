/**
 * Offline regression test for the deliverables wiring (index.js observation ledger ->
 * collectCandidates). No Zotero needed: the sync step is exercised separately by the live e2e.
 *
 * Run: node test/deliverables.test.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href;
const opsRoot = pathToFileURL(path.join(import.meta.dirname, '..', 'operations.mjs')).href;

/* ── fake host ctx that records registrations, like a minimal Cordis ── */
const listeners = new Map();
const tools = new Map();
const commands = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(deps, fn) { fn({ tools: { register: (t) => tools.set(t.name, t) }, commands: { register: (c) => commands.set(c.name, c) } }); },
  on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
  workingDirectory: null,
};

const { apply } = await import(root);
apply(ctx, { source: 'session', scope: 'docs' });

assert.ok(tools.has('zotero_sync'), 'tool zotero_sync registered');
assert.ok(commands.has('zotero'), 'command /zotero registered');

const emit = (event, ...args) => (listeners.get(event) || []).forEach((f) => f(...args));

/* ── fixtures: two files in a temp dir ── */
const dir = path.join(tmpdir(), 'zts-test-' + Date.now());
mkdirSync(dir, { recursive: true });
const mdFile = path.join(dir, 'note.md');
const pdfFile = path.join(dir, 'paper.pdf');
writeFileSync(mdFile, '# note\nhello zotero\n');
writeFileSync(pdfFile, '%PDF-1.4 fake\n');

const agent = { session: { id: 's1', meta: { cwd: dir } } };
const exec = { agent, name: 'write', args: { file_path: mdFile }, callId: 'c1' };

/* 1) write tool result feeds the ledger */
emit('tools/result', exec, { isError: false, meta: { path: mdFile } });

/* 2) present event feeds the ledger (this is the regression: presented files must be found) */
emit('session/event', agent.session, {
  type: 'deliverables/presented',
  data: { turn: 1, callId: 'c2', files: [{ path: pdfFile }] },
});

/* 3) candidates must see BOTH files for session source */
const tool = tools.get('zotero_sync');
const out = await tool.execute(
  { action: 'candidates', source: 'session' },
  { agent, signal: new AbortController().signal },
);
const paths = (out.candidates || []).map((c) => path.basename(c.path)).sort();
assert.deepEqual(paths, ['note.md', 'paper.pdf'], 'both produced and presented files are candidates, got: ' + JSON.stringify(paths));

/* 4) failed tool results contribute nothing */
emit('tools/result', { agent, name: 'write', args: { file_path: path.join(dir, 'ghost.md') }, callId: 'c3' }, { isError: true });
const out2 = await tool.execute({ action: 'candidates', source: 'session' }, { agent, signal: new AbortController().signal });
assert.ok(!(out2.candidates || []).some((c) => c.path.endsWith('ghost.md')), 'failed writes are not candidates');

/* 5) another session cannot see s1's files */
const other = { agent: { session: { id: 's2', meta: { cwd: dir } } }, signal: new AbortController().signal };
const out3 = await tool.execute({ action: 'candidates', source: 'session' }, other);
assert.equal((out3.candidates || []).length, 0, 'session isolation holds');

/* 6) agent/disposed clears the ledger */
emit('agent/disposed', { agent });
const out4 = await tool.execute({ action: 'candidates', source: 'session' }, { agent, signal: new AbortController().signal });
assert.equal((out4.candidates || []).length, 0, 'dispose clears the bucket');

rmSync(dir, { recursive: true, force: true });
console.log('deliverables.test: all 6 assertions passed');
