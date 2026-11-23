/**
 * Title-extraction tests: an uploaded document must be named after the title it declares,
 * not after its filename.
 *
 * Every file lives in a throwaway temp directory and no connector is involved, so this never
 * touches the user's real Zotero or workspace.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.resolve(import.meta.dirname, '..');
const url = (f) => pathToFileURL(path.join(pkg, f)).href;

const { extractDocumentTitle, cleanTitle, titleForDocument } = await import(url('title.mjs'));
const { syncMany } = await import(url('operations.mjs'));

let fail = 0;
const need = (cond, label, extra) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (cond ? '' : '  <- ' + extra));
  if (!cond) fail++;
};

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zts-title-'));
process.env.DSH_PROFILE_DIR = sandbox;

const scratch = mkdtempSync(path.join(os.tmpdir(), 'zts-title-files-'));
const write = (name, body) => {
  const file = path.join(scratch, name);
  writeFileSync(file, body, 'utf8');
  return file;
};

/* ── a Markdown H1 is the document's title ─────────────────────────────── */
const plain = write('202611231336.md', '# Reconstruct Anything Model: a lightweight general model\n\n正文\n');
need(extractDocumentTitle(plain) === 'Reconstruct Anything Model: a lightweight general model',
  'H1 is extracted from a Markdown file', extractDocumentTitle(plain));

const cjk = write('notes.md', '# 马克思主义与社会科学方法论 期末复习\n\n正文\n');
need(extractDocumentTitle(cjk) === '马克思主义与社会科学方法论 期末复习', 'CJK heading survives', extractDocumentTitle(cjk));

/* ── the filename no longer decides the entry title ────────────────────── */
need(titleForDocument(plain, '202611231336.md') === 'Reconstruct Anything Model: a lightweight general model',
  'document title wins over a timestamp-like filename', titleForDocument(plain, '202611231336.md'));

/* ── front matter is the most explicit claim ───────────────────────────── */
const front = write('fm.md', '---\ntitle: "Front Matter Title"\ntags: [a]\n---\n\n# Body Heading\n');
need(extractDocumentTitle(front) === 'Front Matter Title', 'YAML front matter title wins over H1', extractDocumentTitle(front));

const frontUnquoted = write('fm2.md', "---\ntitle: 未加引号的标题\n---\n# H1\n");
need(extractDocumentTitle(frontUnquoted) === '未加引号的标题', 'unquoted front matter title', extractDocumentTitle(frontUnquoted));

/* ── a `#` inside a fenced code block is not the title ─────────────────── */
const fenced = write('code.md', '```bash\n# this is a shell comment\nls\n```\n\n# 真正的标题\n');
need(extractDocumentTitle(fenced) === '真正的标题', 'heading inside a fence is skipped', extractDocumentTitle(fenced));

/* ── setext heading ────────────────────────────────────────────────────── */
const setext = write('setext.md', 'Setext Document Title\n=====================\n\nbody\n');
need(extractDocumentTitle(setext) === 'Setext Document Title', 'setext H1 is recognized', extractDocumentTitle(setext));

/* ── deeper headings still count when there is no H1 ───────────────────── */
const h2 = write('h2.md', '## 只有二级标题\n\n正文\n');
need(extractDocumentTitle(h2) === '只有二级标题', 'H2 is used when no H1 exists', extractDocumentTitle(h2));

/* ── inline Markdown is stripped from the title ────────────────────────── */
const styled = write('styled.md', '# **粗体**标题 与 `代码` 和 [链接](https://example.com)\n');
need(extractDocumentTitle(styled) === '粗体标题 与 代码 和 链接', 'inline markup is stripped', extractDocumentTitle(styled));

/* ── plain text without any heading falls back to its first line ───────── */
const txt = write('plain.txt', '  纯文本第一行  \n第二行\n');
need(extractDocumentTitle(txt) === '纯文本第一行', 'plain text uses its first line', extractDocumentTitle(txt));

/* ── no title available: fall back to the extension-stripped filename ──── */
const empty = write('empty.md', '');
need(extractDocumentTitle(empty) === '', 'empty file yields no title', extractDocumentTitle(empty));
need(titleForDocument(empty, 'empty.md') === 'empty', 'empty file falls back to the filename stem', titleForDocument(empty, 'empty.md'));

const nested = write('nested.md', '```\n# only a fence\n```\n');
need(extractDocumentTitle(nested) === '', 'a file of only a fence yields no title', extractDocumentTitle(nested));
need(titleForDocument(nested, 'nested.md') === 'nested', 'fence-only file falls back to the filename stem', titleForDocument(nested, 'nested.md'));

/* ── binary formats are not guessed at ─────────────────────────────────── */
const pdf = write('paper.pdf', '%PDF-1.4\n# not a heading\n');
need(extractDocumentTitle(pdf) === '', 'PDF contents are never scanned for a title', extractDocumentTitle(pdf));
need(titleForDocument(pdf, 'paper.pdf') === 'paper', 'PDF falls back to the filename stem', titleForDocument(pdf, 'paper' + '.pdf'));

/* ── a missing file never throws ──────────────────────────────────────── */
need(extractDocumentTitle(path.join(scratch, 'does-not-exist.md')) === '', 'missing file yields no title', '');
need(titleForDocument(path.join(scratch, 'does-not-exist.md'), 'ghost.md') === 'ghost', 'missing file falls back to the filename stem', titleForDocument(path.join(scratch, 'does-not-exist.md'), 'ghost.md'));

/* ── pathological heading is capped ────────────────────────────────────── */
const long = write('long.md', '# ' + 'x'.repeat(500) + '\n');
need(extractDocumentTitle(long).length === 200, 'over-long titles are capped at 200 chars', String(extractDocumentTitle(long).length));

/* ── the upload pipeline uses it ──────────────────────────────────────── */
const calls = [];
const stub = {
  saveFile: async (input) => {
    calls.push({ title: input.title, name: input.file.name });
    return { itemKey: input.sessionKey, title: input.title, target: 'C1', attachmentName: input.file.name };
  },
};
const cand = (p) => ({ path: p, name: path.basename(p), size: 8, mtimeMs: Date.now() });

const uploaded = await syncMany({
  zot: stub,
  candidates: [cand(plain)],
  target: 'C1',
  grouped: false,
  force: true,
});
need(calls.length === 1, 'one flat upload happened', String(calls.length));
need(calls[0].title === 'Reconstruct Anything Model: a lightweight general model',
  'flat mode titles the entry from the document, not the filename', calls[0].title);
need(uploaded[0].title === calls[0].title, 'reported title matches what was sent', uploaded[0].title);

/* ── group mode titles the single entry the same way ──────────────────── */
const groupCalls = [];
const groupStub = {
  saveGroup: async (input) => {
    groupCalls.push({ title: input.title, count: input.files.length });
    return { itemKey: input.sessionKey, title: input.title, target: 'C1', attachments: input.files.map((x) => x.name) };
  },
};
await syncMany({ zot: groupStub, candidates: [cand(cjk), cand(plain)], target: 'C1', grouped: true, force: true });
need(groupCalls.length === 1, 'one group upload happened', String(groupCalls.length));
need(groupCalls[0].title === '马克思主义与社会科学方法论 期末复习',
  'group mode titles the entry from the first document in the batch', groupCalls[0].title);

/* ── an explicit title still overrides everything ─────────────────────── */
const overrideCalls = [];
const overrideStub = {
  saveGroup: async (input) => {
    overrideCalls.push(input.title);
    return { itemKey: input.sessionKey, title: input.title, target: 'C1', attachments: input.files.map((x) => x.name) };
  },
};
await syncMany({ zot: overrideStub, candidates: [cand(plain)], target: 'C1', title: '我指定的标题', grouped: true, force: true });
need(overrideCalls[0] === '我指定的标题', 'explicit title still overrides the document title', overrideCalls[0]);

/* ── skipped files do not decide the entry title ──────────────────────── */
const skipCalls = [];
const skipStub = {
  saveGroup: async (input) => {
    skipCalls.push({ title: input.title, names: input.files.map((x) => x.name) });
    return { itemKey: input.sessionKey, title: input.title, target: 'C1', attachments: input.files.map((x) => x.name) };
  },
};
// First upload both, then change only the SECOND file: the entry must be titled after that file,
// because it is the one that actually gets uploaded.
await syncMany({ zot: skipStub, candidates: [cand(cjk), cand(plain)], target: 'C1', grouped: true, force: true });
writeFileSync(plain, '# 改过的标题\n\n正文\n');
const partial = await syncMany({ zot: skipStub, candidates: [cand(cjk), cand(plain)], target: 'C1', grouped: true });
need(skipCalls.length === 2, 'the partial change opened one more group', String(skipCalls.length));
need(skipCalls[1].names.length === 1 && skipCalls[1].names[0] === path.basename(plain),
  'only the changed file is in the second group', JSON.stringify(skipCalls[1].names));
need(skipCalls[1].title === '改过的标题',
  'the entry is titled after the file that is actually uploaded', skipCalls[1].title);
need(partial.filter((o) => o.skipped).length === 1, 'the unchanged file was skipped', JSON.stringify(partial.map((o) => o.skipped)));

/* ── cleanTitle edge cases ─────────────────────────────────────────────── */
need(cleanTitle('###') === '', 'a bare hashes line cleans to empty', JSON.stringify(cleanTitle('###')));
need(cleanTitle(null) === '', 'null cleans to empty', JSON.stringify(cleanTitle(null)));
need(cleanTitle('  A   B  ') === 'A B', 'whitespace is collapsed', JSON.stringify(cleanTitle('  A   B  ')));

rmSync(sandbox, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });

console.log(fail ? `\n${fail} FAILED` : '\nall title tests passed');
process.exit(fail ? 1 : 0);
