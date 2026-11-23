/**
 * Document title extraction for dsh-zotero-sync.
 *
 * Zotero entries used to be named after the file (`论文精读笔记.md` → `论文精读笔记`). That name is
 * a filename, not the document's title, and the two diverge as soon as a note is renamed or lives
 * in a dated folder — the user-visible title in Zotero then reads like a path fragment.
 *
 * This module reads the title the document itself declares, so an uploaded Markdown note lands in
 * Zotero under its own heading. Extraction is deliberately conservative and never throws: a
 * missing or unreadable file simply yields no title, and the caller falls back to the filename.
 *
 * Markdown is the only format where a title is unambiguously declared, so only text formats are
 * read. Binary formats (PDF, DOCX, …) are skipped rather than guessed at.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Extensions whose contents are read for a declared title. */
const TITLE_READABLE = new Set(['.md', '.markdown', '.txt']);

/** Refuse to slurp a huge text file just to find a title. */
const MAX_TITLE_SCAN_BYTES = 256 * 1024;

/**
 * Read the title a document declares in its own content.
 *
 * Precedence, most explicit first:
 *   1. YAML front matter `title:` — an explicit machine-readable claim.
 *   2. The first ATX heading (`# …`) — what a reader sees as the document's title.
 *   3. The first non-empty line, when the file starts with plain text.
 *
 * Setext headings (`Title` underlined with `===`) are also accepted; they only match at the very
 * start of the file, which is where a H1 lives anyway.
 *
 * @param file - absolute path to the document
 * @returns the declared title with Markdown/HTML markup removed, or '' when there is none.
 */
export function extractDocumentTitle(file) {
  let text;
  try {
    if (!TITLE_READABLE.has(path.extname(String(file)).toLowerCase())) return '';
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_TITLE_SCAN_BYTES) return '';
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }

  // Strip a BOM: a leading U+FEFF stops `# ` from being recognised as a heading.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const front = frontMatterTitle(text);
  if (front) return front;

  const lines = text.split(/\r?\n/u);
  const heading = headingTitle(lines);
  if (heading) return heading;

  return firstLineTitle(lines);
}

/** `---\ntitle: X\n---` at the very top of the file. */
function frontMatterTitle(text) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return '';
  for (const line of match[1].split(/\r?\n/u)) {
    const kv = /^\s*title\s*:\s*(.+)$/iu.exec(line);
    if (!kv) continue;
    const raw = kv[1].trim().replace(/^(['"])([\s\S]*)\1$/u, '$2');
    const cleaned = cleanTitle(raw);
    if (cleaned) return cleaned;
  }
  return '';
}

/**
 * First ATX (`#`) or setext (underlined) heading, skipping fenced code blocks so a `#` inside a
 * shell example is not mistaken for the document's title.
 */
function headingTitle(lines) {
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const atx = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (atx) {
      const cleaned = cleanTitle(atx[1]);
      if (cleaned) return cleaned;
      continue;
    }

    // Setext: a non-empty line immediately followed by === or ---. The underline for `---`
    // is also a horizontal rule, so require a preceding text line and no blank line between.
    const next = lines[i + 1];
    if (next && /^\s{0,3}(=+|-{2,})\s*$/u.test(next) && line.trim() && !/^\s{0,3}#/u.test(line)) {
      const cleaned = cleanTitle(line);
      if (cleaned) return cleaned;
    }
  }
  return '';
}

/** A plain first line, used only when the file has no heading at all. */
function firstLineTitle(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Do not treat front matter, code fences, tables, quotes or list markers as titles.
    if (/^(---|\+\+\+|```|~~~|\||>|[-*+]\s|\d+[.)]\s)/u.test(trimmed)) return '';
    const cleaned = cleanTitle(trimmed);
    if (cleaned) return cleaned;
    return '';
  }
  return '';
}

/**
 * Make a heading usable as a Zotero item title: drop inline Markdown/HTML, collapse whitespace,
 * and cap the length so a pathological line cannot become a 5000-character item title.
 *
 * @param value - raw heading text
 * @returns the cleaned title, or '' when nothing usable remains.
 */
export function cleanTitle(value) {
  let text = String(value == null ? '' : value);
  text = text.replace(/<[^>]*>/gu, ' ');            // inline HTML
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1'); // images -> alt text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1');  // links -> label
  text = text.replace(/`+([^`]*)`+/gu, '$1');       // inline code
  text = text.replace(/(\*\*|__)(.*?)\1/gu, '$2');  // bold
  text = text.replace(/(\*|_)(.*?)\1/gu, '$2');     // italic
  text = text.replace(/~~(.*?)~~/gu, '$1');         // strikethrough
  text = text.replace(/\s+/gu, ' ').trim();
  text = text.replace(/^[#\s]+/u, '').replace(/[\s#]+$/u, '');
  if (text.length > 200) text = text.slice(0, 200).trim();
  return text;
}

/**
 * The title to give an uploaded document's parent item.
 *
 * @param file - document path
 * @param name - file basename, used for the extension-stripped fallback
 * @returns the document's own title when it declares one, otherwise the filename without extension.
 */
export function titleForDocument(file, name) {
  return extractDocumentTitle(file) || stripExtension(name || path.basename(String(file || '')));
}

/** Remove a trailing extension so a filename reads as a title. */
export function stripExtension(name) {
  const text = String(name);
  const at = text.lastIndexOf('.');
  return at > 0 ? text.slice(0, at) : text;
}
