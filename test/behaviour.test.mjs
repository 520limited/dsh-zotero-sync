/**
 * Behaviour test for the Host half: drives the registered tool and slash command against a
 * fake ctx, and exercises the upload pipeline against a stubbed connector.
 *
 * Two hard rules, because this test runs on a machine with a real Zotero open:
 *   - every connector URL points at a port nothing listens on (DEAD_BASE);
 *   - every path resolves inside throwaway temp directories, never the real workspace.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.resolve(import.meta.dirname, '..');
const url = (f) => pathToFileURL(path.join(pkg, f)).href;

const host = await import(url('index.js'));
const { collectCandidates, syncMany, tally } = await import(url('operations.mjs'));
const { loadSettings, saveSettings, extensionsFor, SCOPES } = await import(url('settings.mjs'));

let fail = 0;
const need = (cond, label, extra) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (cond ? '' : '  <- ' + extra));
  if (!cond) fail++;
};

/** Isolate state: the plugin persists settings under DSH_PROFILE_DIR. */
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zts-test-'));
process.env.DSH_PROFILE_DIR = sandbox;

/** A port nothing listens on, so no test can touch the user's real Zotero. */
const DEAD_BASE = 'http://127.0.0.1:23999';

/** Fake session working directory, so a workspace scan never sees the real one. */
const workspace = mkdtempSync(path.join(os.tmpdir(), 'zts-ws-'));
const mdFile = path.join(workspace, '论文精读笔记.md');
const pdfFile = path.join(workspace, 'paper.pdf');
const pngFile = path.join(workspace, 'figure.png');
const throwFile = path.join(workspace, 'throw-me.md');
writeFileSync(mdFile, '# 笔记\n正文\n');
writeFileSync(pdfFile, '%PDF-1.4 fake');
writeFileSync(pngFile, 'binary-ish');
writeFileSync(throwFile, '# throw\n');

/* ── fake ctx ───────────────────────────────────────────────────────────── */
function makeCtx() {
  const registered = { tools: [], commands: [] };
  const listeners = {};
  const effects = [];
  const scopes = {
    tools: { register: (d) => registered.tools.push(d) },
    commands: { register: (d) => registered.commands.push(d) },
    workingDirectory: { ensure: async () => workspace },
  };
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => (name === 'workingDirectory' ? scopes.workingDirectory : undefined),
    inject: (names, fn) => {
      const scope = {};
      for (const n of names) scope[n] = scopes[n];
      return fn(scope);
    },
    on: (name, fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    effect: (fn) => { effects.push(fn); },
  };
  return { ctx, registered, listeners, effects };
}

const { ctx, registered } = makeCtx();
host.apply(ctx, { baseUrl: DEAD_BASE, scope: 'md', source: 'session' });

const tool = registered.tools.find((t) => t.name === 'zotero_sync');
const command = registered.commands.find((c) => c.name === 'zotero');
need(!!tool, 'zotero_sync tool registered', '');
need(!!command, '/zotero command registered', '');
need(tool && tool.parameters.required?.includes('action'), 'action is required', JSON.stringify(tool?.parameters.required));
need(tool && typeof tool.output?.render === 'function', 'output render provided', '');
const enums = tool ? tool.parameters.properties : {};
need(JSON.stringify(enums.scope.enum) === '["md","docs","all"]', 'scope enum matches the product decision', JSON.stringify(enums.scope?.enum));
need(JSON.stringify(enums.source.enum) === '["session","workspace"]', 'source enum', JSON.stringify(enums.source?.enum));

/* ── scope × source selection ──────────────────────────────────────────── */
const settings = () => loadSettings({ baseUrl: DEAD_BASE, scope: 'md', source: 'session' });

const mdOnly = await collectCandidates({ settings: settings(), cwd: workspace, source: 'workspace' });
need(mdOnly.length === 1 && mdOnly[0].name === '论文精读笔记.md', 'scope=md keeps only Markdown', JSON.stringify(mdOnly.map((c) => c.name)));

const docsOnly = await collectCandidates({ settings: { ...settings(), scope: 'docs' }, cwd: workspace, source: 'workspace' });
need(docsOnly.length === 2, 'scope=docs keeps Markdown + PDF, drops .png', JSON.stringify(docsOnly.map((c) => c.name)));

const allSession = await collectCandidates({
  settings: { ...settings(), scope: 'all' },
  cwd: workspace,
  source: 'session',
  produced: [mdFile, pngFile],
});
need(allSession.length === 2, 'scope=all takes every session file', JSON.stringify(allSession.map((c) => c.name)));

const allWorkspace = await collectCandidates({ settings: { ...settings(), scope: 'all' }, cwd: workspace, source: 'workspace' });
need(allWorkspace.length === 2, 'scope=all degrades to docs for a workspace scan', JSON.stringify(allWorkspace.map((c) => c.name)));

const sessionEmpty = await collectCandidates({ settings: settings(), cwd: workspace, source: 'session', produced: [] });
need(sessionEmpty.length === 0, 'source=session with no produced files is empty (no surprise upload)', '');

const explicit = await collectCandidates({ settings: settings(), cwd: workspace, paths: [pdfFile] });
need(explicit.length === 1, 'explicit paths bypass the md-only scope', JSON.stringify(explicit.map((c) => c.name)));

const missing = await collectCandidates({ settings: settings(), cwd: workspace, paths: ['nope.md'] });
need(missing.length === 0, 'a named file that does not exist is dropped', '');

const spacedFile = path.join(workspace, 'my note 中文.md');
writeFileSync(spacedFile, '# spaced\n');
const spaced = await collectCandidates({ settings: settings(), cwd: workspace, paths: [spacedFile] });
need(spaced.length === 1, 'a path containing spaces resolves as one argument', JSON.stringify(spaced.map((c) => c.name)));

/* ── settings layering ─────────────────────────────────────────────────── */
const stored = saveSettings({ target: 'C7', scope: 'all' }, loadSettings({ baseUrl: DEAD_BASE, scope: 'md' }));
need(stored.target === 'C7' && stored.scope === 'all', 'saveSettings persists', JSON.stringify({ t: stored.target, s: stored.scope }));
const reloaded = loadSettings({ baseUrl: DEAD_BASE, scope: 'md', target: 'L1' });
need(reloaded.scope === 'all' && reloaded.target === 'C7', 'stored choices win over patch defaults', JSON.stringify({ s: reloaded.scope, t: reloaded.target }));
const rejected = saveSettings({ scope: 'bogus', target: 'ZZ9' }, stored);
need(rejected.scope === 'all' && rejected.target === 'C7', 'invalid values are dropped, not merged', JSON.stringify({ s: rejected.scope, t: rejected.target }));
need(extensionsFor({ scope: 'md' }).includes('.md') && !extensionsFor({ scope: 'md' }).includes('.pdf'), 'md scope excludes pdf', '');
need(SCOPES.all === null, 'all scope means no type filter', String(SCOPES.all));

/* ── upload pipeline against a stub connector ─────────────────────────── */
const calls = [];
const stub = {
  saveFile: async (input) => {
    calls.push({ title: input.title, target: input.target, tags: input.tags, name: input.file.name });
    if (/throw/iu.test(input.title)) throw new Error('stub refused');
    return { itemKey: input.sessionKey, title: input.title, target: input.target || 'L1', attachmentName: input.file.name };
  },
};

const outcomes = await syncMany({
  zot: stub,
  candidates: [{ path: mdFile, name: path.basename(mdFile), size: 10, mtimeMs: Date.now() }],
  target: 'C1',
  tags: ['DSH对话笔记'],
});
need(outcomes.length === 1 && !outcomes[0].error, 'upload succeeded', JSON.stringify(outcomes[0]));
need(outcomes[0].attachment === path.basename(mdFile), 'attachment name reported', outcomes[0].attachment);
need(calls[0].target === 'C1', 'target forwarded', String(calls[0].target));

const again = await syncMany({
  zot: stub,
  candidates: [{ path: mdFile, name: path.basename(mdFile), size: 10, mtimeMs: Date.now() }],
  target: 'C1',
});
need(again[0].skipped === true, 'unchanged file is skipped by content hash', JSON.stringify(again[0]));

const forced = await syncMany({
  zot: stub,
  candidates: [{ path: mdFile, name: path.basename(mdFile), size: 10, mtimeMs: Date.now() }],
  target: 'C1',
  force: true,
});
need(!forced[0].skipped, 'force re-uploads', JSON.stringify(forced[0]));

const changed = await syncMany({
  zot: stub,
  candidates: [{ path: pdfFile, name: path.basename(pdfFile), size: 11, mtimeMs: Date.now() }],
  target: 'C1',
});
need(!changed[0].error, 'a different file uploads independently', JSON.stringify(changed[0]));

// A file the history has never seen, so the skip path cannot mask the failure path.
const thrown = await syncMany({
  zot: { saveFile: async () => { throw new Error('stub refused'); } },
  candidates: [{ path: throwFile, name: path.basename(throwFile), size: 9, mtimeMs: 0 }],
  target: 'C1',
});
need(!!thrown[0].error, 'a thrown upload reports an error row', JSON.stringify(thrown[0]));
const counts = tally(outcomes.concat(thrown));
need(counts.failCount === 1 && counts.okCount === 1, 'tally counts successes and failures', JSON.stringify(counts));

/* ── command surface ──────────────────────────────────────────────────── */
async function runCmd(line, agent) {
  return command.handler({
    agent: agent || { session: { id: 'test-session', meta: { cwd: workspace } } },
    rawInput: line,
    signal: new AbortController().signal,
  });
}

const statusDead = await runCmd('status');
need(statusDead.kind === 'error' && /未响应|UNREACHABLE|启动 Zotero/u.test(statusDead.text),
  'status against a dead Zotero explains itself', JSON.stringify(statusDead).slice(0, 160));

const unknownVerb = await runCmd('frobnicate');
need(unknownVerb.kind === 'error' && /未知子命令/u.test(unknownVerb.text), 'unknown verb is a clean error', JSON.stringify(unknownVerb));

const badUse = await runCmd('use XX');
need(badUse.kind === 'error' && /L1 或 C23/u.test(badUse.text), 'bad target id rejected', JSON.stringify(badUse));

const scopeSet = await runCmd('scope md');
need(scopeSet.kind === 'success' && /Markdown/u.test(scopeSet.text), 'scope verb works', JSON.stringify(scopeSet));
need(loadSettings({ baseUrl: DEAD_BASE }).scope === 'md', 'scope persisted', '');

const badScope = await runCmd('scope nonsense');
need(badScope.kind === 'error', 'bad scope value rejected', JSON.stringify(badScope));

const badSource = await runCmd('source nonsense');
need(badSource.kind === 'error', 'bad source value rejected', JSON.stringify(badSource));

const srcSet = await runCmd('source workspace');
need(srcSet.kind === 'success', 'source verb works', JSON.stringify(srcSet));
need(loadSettings({ baseUrl: DEAD_BASE }).source === 'workspace', 'source persisted', '');

// Back to session source so `sync` below has nothing real to upload in the temp workspace…
await runCmd('source session');
const emptySync = await runCmd('sync', { session: { id: 'never-used-session', meta: { cwd: workspace } } });
need(emptySync.kind === 'error' && /没有/u.test(emptySync.text),
  'sync with nothing produced explains itself instead of scanning', JSON.stringify(emptySync).slice(0, 160));

// Explicit paths reach the upload stage; with the dead base URL that stage must fail cleanly.
const quotedSync = await runCmd('sync "' + spacedFile.replace(/"/g, '\\"') + '"');
need(quotedSync.kind === 'error' && /UNREACHABLE|connect|fetch failed|Zotero/iu.test(quotedSync.text),
  'quoted path reached the upload stage and failed cleanly', JSON.stringify(quotedSync).slice(0, 220));

/* ── the tool path uses the same operation ─────────────────────────────── */
const exec = { agent: { session: { id: 'tool-session', meta: { cwd: workspace } } }, signal: new AbortController().signal };
const pingResult = await tool.execute({ action: 'status' }, exec);
need(pingResult.ok === false && /启动 Zotero/u.test(pingResult.message), 'tool status reports offline', JSON.stringify(pingResult).slice(0, 160));

const candResult = await tool.execute({ action: 'candidates', source: 'session' }, exec);
need(candResult.ok === true && Array.isArray(candResult.candidates), 'tool candidates returns a list', JSON.stringify(candResult).slice(0, 120));

const syncNothing = await tool.execute({ action: 'sync', source: 'session' }, exec);
need(syncNothing.ok === false && syncNothing.results.length === 0, 'tool sync with no files is a clean no-op', JSON.stringify(syncNothing).slice(0, 160));

let threw = null;
try {
  await tool.execute({ action: 'nonsense' }, exec);
} catch (error) {
  threw = error;
}
need(!!threw && /unknown action/u.test(String(threw.message)), 'unknown tool action throws', String(threw && threw.message));

const cfg = await tool.execute({ action: 'configure', scope: 'md', source: 'session' }, exec);
need(cfg.ok === true && /Markdown/u.test(cfg.message), 'configure persists scope', JSON.stringify(cfg).slice(0, 160));

rmSync(sandbox, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });

console.log(fail === 0 ? '\nALL BEHAVIOUR CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
