/**
 * File discovery and upload orchestration for dsh-zotero-sync.
 *
 * Shared by the agent tool, the /zotero command, and the composer/tail chip so all three do
 * exactly the same thing. Nothing here knows Zotero's wire format (zotero.mjs) or DSH services
 * (index.js): plain data in, plain data out.
 *
 * Two independent knobs, matching what a user actually decides:
 *   source  — where files come from: `session` (what this conversation produced) or
 *             `workspace` (scan the working directory).
 *   scope   — which types to accept: `md` (Markdown only), `docs` (Markdown/PDF/Office/web),
 *             or `all` (anything, session source only).
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ZoteroError, contentTypeFor } from './zotero.mjs';
import { DIR_NAMES_SKIP, SCOPES } from './settings.mjs';
import { loadHistory, recordUpload } from './history.mjs';

/**
 * Build the list of files to act on.
 *
 * @param options - {
 *   settings: object           effective settings
 *   cwd: string                session working directory
 *   source?: 'session'|'workspace'
 *   scope?: 'md'|'docs'|'all'
 *   paths?: string[]           explicit paths, overriding source
 *   produced?: string[]        files this session wrote or presented (host-side observation)
 *   limit?: number
 * }
 * @returns {Promise<Array<{ path, name, size, mtimeMs, source }>>}
 */
export async function collectCandidates(options) {
  const settings = options.settings || {};
  const cwd = options.cwd || process.cwd();
  const source = pickSource(options.source, settings, options.paths);
  const wanted = wantedFor(options.scope || settings.scope, source, settings);
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, options.limit)
    : settings.workspaceLimit || 20;
  const keep = (candidate) => acceptable(candidate, wanted, settings);

  if (Array.isArray(options.paths) && options.paths.length) {
    // An explicitly named file is the user's own choice: honor it even when its type is outside
    // the configured scope, so picking a .doc in the UI never silently uploads nothing.
    return options.paths
      .map((p) => toCandidate(p, cwd, 'explicit'))
      .filter((c) => c && !c.missing && !c.directory && withinSize(c, settings));
  }

  if (source === 'workspace') {
    return scanDirectory(cwd, wanted, settings, limit);
  }

  const session = [...new Set(options.produced || [])]
    .map((p) => toCandidate(p, cwd, 'session'))
    .filter(keep);
  if (session.length) return session.slice(0, limit);
  // Nothing provable for this session (fresh conversation, or the Host restarted and dropped
  // the live observation). Say so through an empty list rather than silently uploading files
  // the conversation never touched.
  return [];
}

function pickSource(requested, settings, paths) {
  if (Array.isArray(paths) && paths.length) return 'explicit';
  const value = String(requested || settings.source || 'session').toLowerCase();
  return value === 'workspace' ? 'workspace' : 'session';
}

/** Extension list for a scope, or null meaning "any type". */
function wantedFor(scope, source, settings) {
  const key = String(scope || settings.scope || 'docs').toLowerCase();
  if (key === 'all') {
    // "everything" only makes sense for files this conversation produced; a workspace scan with
    // no type filter would drag in unrelated binaries.
    return source === 'workspace' ? SCOPES.docs.slice() : null;
  }
  if (Array.isArray(settings.extensions) && settings.extensions.length) {
    return settings.extensions.map((x) => String(x).toLowerCase());
  }
  return SCOPES[key] ? SCOPES[key].slice() : SCOPES.docs.slice();
}

function acceptable(candidate, wanted, settings) {
  if (!candidate || candidate.missing || candidate.directory) return false;
  if (wanted && !wanted.includes(path.extname(candidate.name).toLowerCase())) return false;
  return withinSize(candidate, settings);
}

function withinSize(candidate, settings) {
  return !(settings.maxFileBytes && candidate.size > settings.maxFileBytes);
}

/** Absolute path plus stats for one declared file. */
function toCandidate(raw, cwd, source) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const full = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
  let st;
  try {
    st = statSync(full);
  } catch {
    return { path: full, name: path.basename(full), size: 0, mtimeMs: 0, missing: true, source };
  }
  if (st.isDirectory()) {
    return { path: full, name: path.basename(full), size: 0, mtimeMs: st.mtimeMs, directory: true, source };
  }
  return { path: full, name: path.basename(full), size: st.size, mtimeMs: st.mtimeMs, source };
}

/** Depth-limited workspace scan, newest first, skipping dependency and build folders. */
function scanDirectory(root, wanted, settings, limit) {
  const results = [];
  const maxDepth = Math.max(1, settings.workspaceDepth || 3);
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || DIR_NAMES_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (wanted && !wanted.includes(path.extname(entry.name).toLowerCase())) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (settings.maxFileBytes && st.size > settings.maxFileBytes) continue;
      results.push({ path: full, name: entry.name, size: st.size, mtimeMs: st.mtimeMs, source: 'workspace' });
    }
  };
  walk(root, 1);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

/**
 * Upload one file, skipping it when the same bytes are already recorded as uploaded.
 * @param options - { zot, candidate, target, tags, title, force, standalone }
 */
export async function syncOne(options) {
  const { zot, candidate, target, tags = [], title, force = false, standalone = false } = options;
  const base = { file: candidate.path, name: candidate.name };
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(candidate.path));
  } catch (error) {
    return { ...base, error: '读取文件失败：' + String((error && error.message) || error) };
  }
  const hash = createHash('sha1').update(bytes).digest('hex');

  const previous = loadHistory()[candidate.path];
  if (!force && previous && previous.hash === hash) {
    return {
      ...base,
      skipped: true,
      reason: `内容未变化，已在 ${previous.target || 'Zotero'}（${previous.title || previous.attachment || candidate.name}）`,
      title: previous.title,
      target: previous.target,
      attachment: previous.attachment,
    };
  }

  const displayTitle = (title && String(title).trim()) || stripExtension(candidate.name);
  const sessionKey = 'dsh' + hash.slice(0, 20) + '-' + Date.now().toString(36).slice(-5);
  try {
    const saved = await zot.saveFile({
      sessionKey,
      title: displayTitle,
      file: { path: candidate.path, bytes, name: candidate.name },
      contentType: contentTypeFor(candidate.name),
      target,
      tags,
      standalone,
      date: new Date(candidate.mtimeMs || Date.now()).toISOString().slice(0, 10),
    });
    recordUpload(candidate.path, {
      hash,
      size: bytes.length,
      title: saved.title,
      target: saved.target,
      attachment: saved.attachmentName,
    });
    return { ...base, title: saved.title, target: saved.target, attachment: saved.attachmentName, bytes: bytes.length };
  } catch (error) {
    return { ...base, error: describeError(error), bytes: bytes.length };
  }
}

/**
 * Upload a batch sequentially: one connector session per file, ordered results.
 * @param options - { zot, candidates, target, tags, title, force, standalone,
 *                   rememberTargetOnSuccess, onSetTarget }
 */
export async function syncMany(options) {
  const { zot, candidates = [], target, tags, title, force, standalone, onSetTarget, rememberTargetOnSuccess } = options;
  if (!zot || typeof zot.saveFile !== 'function') throw new Error('syncMany needs a ZoteroConnector as "zot"');
  const chosen = target && /^[LC]\d+$/u.test(String(target)) ? String(target) : undefined;
  const outcomes = [];
  for (const candidate of candidates) {
    const outcome = await syncOne({
      zot,
      candidate,
      target: chosen,
      tags,
      title: candidates.length === 1 ? title : undefined,
      force,
      standalone,
    });
    outcomes.push(outcome);
    // Remember the first destination actually used, so later runs stop depending on whatever
    // Zotero happened to have selected in its own UI.
    if (!chosen && rememberTargetOnSuccess && outcome.target && /^([LC]\d+)$/u.test(outcome.target) && onSetTarget) {
      onSetTarget(outcome.target);
    }
  }
  return outcomes;
}

/** Human-readable failure text that keeps the machine code visible for logs. */
export function describeError(error) {
  if (error instanceof ZoteroError) {
    const hint = {
      UNREACHABLE: '请确认 Zotero 桌面端已启动（它自带本地服务，无需额外插件）。',
      TIMEOUT: 'Zotero 没有及时响应，可能正在忙或库很大。',
      READ_ONLY_LIBRARY: '目标文库是只读的。',
      FILES_READONLY: '该文库不允许写入附件文件。',
      SESSION_EXPIRED: 'Zotero 的保存会话已过期，请重试。',
      COLLECTION_NOT_FOUND: '集合 ID 不存在，用 /zotero targets 重新选择。',
      VERSION_OUTDATED: '插件使用的 Connector 协议版本过旧。',
      NO_FETCH: '当前 Node 版本没有 fetch，需要 Node 18+。',
    }[error.code];
    return `[${error.code}] ${error.message}` + (hint ? '\n    建议：' + hint : '');
  }
  return String((error && error.message) || error);
}

function stripExtension(name) {
  const text = String(name);
  const at = text.lastIndexOf('.');
  return at > 0 ? text.slice(0, at) : text;
}

/** Count helper shared with the callers' summaries. */
export function tally(outcomes) {
  return {
    okCount: outcomes.filter((o) => !o.error && !o.skipped).length,
    skippedCount: outcomes.filter((o) => o.skipped).length,
    failCount: outcomes.filter((o) => o.error).length,
  };
}
