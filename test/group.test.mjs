/**
 * Group-mode tests: several files uploaded in one sync must become ONE Zotero entry
 * (one parent item with N attachments), not N separate entries.
 *
 * Every connector URL points at a port nothing listens on, and every path lives in a throwaway
 * temp directory, so this never touches the user's real Zotero or workspace.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.resolve(import.meta.dirname, '..');
const url = (f) => pathToFileURL(path.join(pkg, f)).href;

const { syncMany, tally } = await import(url('operations.mjs'));
const { loadSettings, DEFAULTS } = await import(url('settings.mjs'));

let fail = 0;
const need = (cond, label, extra) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (cond ? '' : '  <- ' + extra));
  if (!cond) fail++;
};

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zts-group-'));
process.env.DSH_PROFILE_DIR = sandbox;
const scratch = mkdtempSync(path.join(os.tmpdir(), 'zts-group-files-'));

const f1 = path.join(scratch, '笔记.md');
const f2 = path.join(scratch, '论文.pdf');
const f3 = path.join(scratch, '图表.png');
writeFileSync(f1, '# 甲\n');
writeFileSync(f2, '%PDF-1.4 乙');
writeFileSync(f3, '丙');

const cand = (p) => ({ path: p, name: path.basename(p), size: 8, mtimeMs: Date.now() });

/* ── default setting ────────────────────────────────────────────────────── */
need(loadSettings({}).groupIntoOne === true, 'groupIntoOne defaults to true', String(loadSettings({}).groupIntoOne));
need(DEFAULTS.groupIntoOne === true, 'DEFAULTS exposes the flag', String(DEFAULTS.groupIntoOne));

/* ── group mode: one saveGroup call, no per-file saveFile ────────────────── */
const groupCalls = [];
let fileCalls = 0;
const groupStub = {
  // Deliberately present: group mode must prefer saveGroup over saveFile.
  saveFile: async () => { fileCalls++; throw new Error('group mode must not call saveFile'); },
  saveGroup: async (input) => {
    groupCalls.push({
      sessionKey: input.sessionKey,
      title: input.title,
      fileCount: input.files.length,
      names: input.files.map((x) => x.name),
      target: input.target,
      tags: input.tags,
    });
    return { itemKey: input.sessionKey, title: input.title, target: input.target, attachments: input.files.map((x) => x.name) };
  },
};

const grouped = await syncMany({
  zot: groupStub,
  candidates: [cand(f1), cand(f2), cand(f3)],
  target: 'C1',
  tags: ['DSH对话笔记'],
  grouped: true,
});
need(groupCalls.length === 1, 'exactly one saveGroup call for 3 files', String(groupCalls.length));
need(fileCalls === 0, 'saveFile is never called in group mode', String(fileCalls));
need(groupCalls[0].fileCount === 3, 'all 3 files go into the one group', String(groupCalls[0].fileCount));
need(!grouped.some((o) => o.error), 'no errors in grouped result', JSON.stringify(grouped));
need(grouped.every((o) => o.grouped === true), 'every outcome is flagged grouped', JSON.stringify(grouped.map((o) => o.grouped)));
need(new Set(grouped.map((o) => o.groupKey)).size === 1, 'all outcomes share one parent key', JSON.stringify(grouped.map((o) => o.groupKey)));
need(new Set(grouped.map((o) => o.title)).size === 1, 'all outcomes share one entry title', JSON.stringify(grouped.map((o) => o.title)));
need(grouped[0].title === '笔记', 'group title defaults to first file stem', grouped[0].title);
need(grouped.length === 3, 'one outcome row per file', String(grouped.length));

/* ── ordering is preserved ──────────────────────────────────────────────── */
need(
  grouped.map((o) => o.name).join('|') === [path.basename(f1), path.basename(f2), path.basename(f3)].join('|'),
  'outcome order matches input order',
  grouped.map((o) => o.name).join('|'),
);

/* ── dedupe: re-running the same batch opens no session ──────────────────── */
const rerun = await syncMany({
  zot: groupStub,
  candidates: [cand(f1), cand(f2), cand(f3)],
  target: 'C1',
  grouped: true,
});
need(groupCalls.length === 1, 'no second saveGroup call when nothing changed', String(groupCalls.length));
need(rerun.every((o) => o.skipped === true), 'all three reported skipped', JSON.stringify(rerun.map((o) => o.skipped)));

/* ── partial change: only the changed file is re-uploaded ────────────────── */
writeFileSync(f2, '%PDF-1.5 乙改');
const partial = await syncMany({
  zot: groupStub,
  candidates: [cand(f1), cand(f2), cand(f3)],
  target: 'C1',
  grouped: true,
});
need(groupCalls.length === 2, 'one more saveGroup call for the partial change', String(groupCalls.length));
need(groupCalls[1].fileCount === 1, 'only the changed file joins the new group', String(groupCalls[1].fileCount));
const okRows = partial.filter((o) => !o.skipped && !o.error);
const skipRows = partial.filter((o) => o.skipped);
need(okRows.length === 1 && skipRows.length === 2, 'one uploaded, two skipped', JSON.stringify(partial.map((o) => o.skipped)));
need(tally(partial).okCount === 1, 'tally counts the single upload', JSON.stringify(tally(partial)));

/* ── explicit title wins ────────────────────────────────────────────────── */
const titled = await syncMany({
  zot: groupStub,
  candidates: [cand(f1), cand(f3)],
  target: 'C1',
  title: '一次回答的全部文件',
  grouped: true,
  force: true,
});
need(titled[0].title === '一次回答的全部文件', 'explicit title used for the group', titled[0].title);

/* ── failure fans out to every file in the group ────────────────────────── */
const boom = await syncMany({
  zot: { saveFile: async () => { throw new Error('nope'); }, saveGroup: async () => { throw new Error('group refused'); } },
  candidates: [cand(f1), cand(f3)],
  target: 'C1',
  grouped: true,
  force: true,
});
need(boom.length === 2 && boom.every((o) => o.error), 'a failed group reports an error per file', JSON.stringify(boom));

/* ── flat mode still creates one entry per file ─────────────────────────── */
let flatCalls = 0;
const flatStub = {
  saveFile: async (input) => { flatCalls++; return { itemKey: input.sessionKey, title: input.title, target: 'C1', attachmentName: input.file.name }; },
  saveGroup: async () => { throw new Error('must not group when grouped=false'); },
};
const flat = await syncMany({
  zot: flatStub,
  candidates: [cand(f1), cand(f3)],
  target: 'C1',
  grouped: false,
  force: true,
});
need(flatCalls === 2, 'grouped=false saves each file separately', String(flatCalls));
need(!flat.some((o) => o.grouped), 'flat results are not marked grouped', JSON.stringify(flat.map((o) => o.grouped)));

/* ── single candidate in group mode still yields one attachment ─────────── */
const soloCalls = [];
const soloStub = { saveGroup: async (input) => { soloCalls.push(input.files.length); return { itemKey: input.sessionKey, title: input.title, target: 'C1', attachments: input.files.map((x) => x.name) }; } };
await syncMany({ zot: soloStub, candidates: [cand(f1)], target: 'C1', grouped: true, force: true });
need(soloCalls.length === 1 && soloCalls[0] === 1, 'group mode handles a single file', JSON.stringify(soloCalls));

rmSync(sandbox, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });

console.log(fail ? `\n${fail} FAILED` : '\nall group-mode tests passed');
process.exit(fail ? 1 : 0);
