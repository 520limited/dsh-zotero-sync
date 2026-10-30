/**
 * User-tunable settings for dsh-zotero-sync.
 *
 * Persisted outside the profile patch so that picking a collection or an upload scope is a
 * runtime action (chip, /zotero, or the agent tool), not a file edit.
 *
 * Layering, highest wins: explicit call argument > stored file > patch `config` > DEFAULTS.
 * The patch layer stays authoritative for anything hand-written in cordis.patch.yml; the stored
 * file only ever holds what the user chose at runtime.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PACKAGE_ID = 'dsh-zotero-sync';

/**
 * 上传范围 = 允许的文件类型。`all` 表示不限类型，但只对本会话产出的文件生效
 * （工作区扫描配 all 会连依赖目录里的文件一起抓，所以 source 会被强制回 session）。
 */
export const SCOPES = {
  /** 只要 Markdown。 */
  md: ['.md', '.markdown'],
  /** Markdown + PDF + Office + 网页/电子书。 */
  docs: [
    '.md', '.markdown', '.txt', '.pdf',
    '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
    '.html', '.htm', '.epub',
  ],
  /** 本会话产出的所有文件，不限类型。 */
  all: null,
};

export const SOURCE_KEYS = ['session', 'workspace'];

export const DEFAULTS = {
  /** Zotero's built-in connector server. */
  baseUrl: 'http://127.0.0.1:23119',
  timeoutMs: 20000,
  /** md | docs | all */
  scope: 'docs',
  /** session (files this conversation wrote or presented) | workspace (scan the working dir) */
  source: 'session',
  /** Overrides `scope` when set; a list of extensions starting with ".". */
  extensions: null,
  /**
   * 一次上传多个文件时，是否合并进同一个 Zotero 条目。
   * true（默认）= 一次 sync 的多个文件建一个条目，各文件作为该条目的附件；
   * false = 每个文件一个独立条目（旧行为）。
   */
  groupIntoOne: true,
  /** Zotero treeViewID; empty means "wherever Zotero is currently pointing". */
  target: '',
  /** Tags added to every uploaded item, merged with per-call tags. */
  tags: ['DSH对话笔记'],
  /** Max files a workspace scan returns, newest first. */
  workspaceLimit: 20,
  /** How deep a workspace scan walks. */
  workspaceDepth: 3,
  /** Refuse to read a single file bigger than this. */
  maxFileBytes: 80 * 1024 * 1024,
};

/** Directories a workspace scan never enters. */
export const DIR_NAMES_SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'coverage',
  '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.dsh', '.pnpm-store',
  'vendor', 'storage', 'library', '.obsidian', '.gradle', '.mvn', 'tmp', 'temp',
]);

/** Where the settings file lives, profile-scoped so profiles can differ. */
export function settingsPath() {
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh');
  return path.join(base, 'plugin-data', PACKAGE_ID, 'settings.json');
}

/**
 * @param overrides - config from the Loader row (may be undefined).
 * @returns effective settings, always complete.
 */
export function loadSettings(overrides = {}) {
  const patch = sanitize(overrides);
  const stored = sanitize(readStored());
  return { ...DEFAULTS, ...patch, ...stored };
}

/** @returns the extension list a scope+source pair should accept, or null for "anything". */
export function extensionsFor(current) {
  if (Array.isArray(current.extensions) && current.extensions.length) {
    return current.extensions.map((x) => String(x).toLowerCase());
  }
  const key = SCOPES[current.scope] === undefined ? 'docs' : current.scope;
  const list = SCOPES[key];
  return list ? list.slice() : null;
}

function readStored() {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge a partial change into the stored document.
 *
 * The patch is validated on its own before merging: an invalid value (a typo like
 * `scope: "bogus"`) must not wipe a valid stored choice, it is simply dropped.
 * @param patch - fields to write.
 * @param base - current effective settings used as the merge source.
 * @returns the sanitized stored document, or `{ __error }` when writing failed.
 */
export function saveSettings(patch, base = loadSettings()) {
  const accepted = sanitize(patch);
  const next = sanitize({ ...base, ...accepted });
  const file = settingsPath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, file);
    return next;
  } catch (error) {
    return { __error: String((error && error.message) || error) };
  }
}

/** Keep only known fields with sane types: a hand-edited file must not break startup. */
function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  if (typeof input.baseUrl === 'string' && /^https?:\/\//iu.test(input.baseUrl)) {
    out.baseUrl = input.baseUrl.replace(/\/+$/, '');
  }
  if (Number.isFinite(input.timeoutMs)) out.timeoutMs = clamp(input.timeoutMs, 1000, 120000);
  if (typeof input.scope === 'string' && Object.keys(SCOPES).includes(input.scope.toLowerCase())) {
    out.scope = input.scope.toLowerCase();
  }
  if (typeof input.source === 'string' && SOURCE_KEYS.includes(input.source.toLowerCase())) {
    out.source = input.source.toLowerCase();
  }
  if (Array.isArray(input.extensions)) {
    const list = input.extensions
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => (x.startsWith('.') ? x : '.' + x).toLowerCase());
    if (list.length) out.extensions = list;
  } else if (input.extensions === null) {
    out.extensions = null;
  }
  if (typeof input.target === 'string') {
    const target = input.target.trim().toUpperCase();
    // Accept the empty "use wherever Zotero points" value and a real treeViewID only, so a
    // typo cannot be persisted and then fail every upload with an opaque Zotero 400.
    if (target === '' || /^[LC]\d+$/u.test(target)) out.target = target;
  }
  if (Array.isArray(input.tags)) {
    out.tags = [...new Set(input.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()))];
  }
  if (typeof input.groupIntoOne === 'boolean') out.groupIntoOne = input.groupIntoOne;
  if (Number.isFinite(input.workspaceLimit)) out.workspaceLimit = clamp(input.workspaceLimit, 1, 200);
  if (Number.isFinite(input.workspaceDepth)) out.workspaceDepth = clamp(input.workspaceDepth, 1, 6);
  if (Number.isFinite(input.maxFileBytes)) out.maxFileBytes = clamp(input.maxFileBytes, 1024, 1024 ** 3);
  return out;
}

function clamp(value, lo, hi) {
  const n = Math.floor(Number(value));
  return n < lo ? lo : n > hi ? hi : n;
}
