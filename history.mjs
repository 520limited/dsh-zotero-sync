/**
 * Upload memory for dsh-zotero-sync.
 *
 * Keyed by absolute file path, holding the content hash of what was last successfully
 * uploaded. That is what makes "sync this conversation's notes" idempotent: run it twice on
 * an unchanged file and the second run reports "already in Zotero" instead of creating a
 * duplicate item.
 *
 * This is a derived convenience cache, not a source of truth: losing it only means an
 * unchanged file may be uploaded once more.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PACKAGE_ID = 'dsh-zotero-sync';
const VERSION = 1;

export function historyPath() {
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh');
  return path.join(base, 'plugin-data', PACKAGE_ID, 'history.json');
}

/** @returns {Record<string, object>} stored map keyed by absolute path; {} on any problem. */
export function loadHistory() {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : parsed;
    const out = {};
    for (const [key, value] of Object.entries(entries)) {
      if (value && typeof value === 'object' && typeof value.hash === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record one successful upload.
 * @param fileKey - absolute path
 * @param record - { hash, size, title, target, attachment }
 * @returns the stored document, or `{ __error }` when writing failed.
 */
export function recordUpload(fileKey, record) {
  const all = loadHistory();
  all[fileKey] = {
    hash: String(record.hash || ''),
    size: Number.isFinite(record.size) ? record.size : 0,
    title: record.title || '',
    target: record.target || '',
    attachment: record.attachment || '',
    uploadedAt: new Date().toISOString(),
  };
  return writeAll(all);
}

/** Drop one file's record so the next sync re-uploads it. */
export function forgetUpload(fileKey) {
  const all = loadHistory();
  delete all[fileKey];
  return writeAll(all);
}

function writeAll(entries) {
  const file = historyPath();
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file + '.tmp-' + process.pid, JSON.stringify({ version: VERSION, entries }, null, 2), 'utf8');
    renameSync(file + '.tmp-' + process.pid, file);
    return { version: VERSION, entries };
  } catch (error) {
    return { __error: String(error && error.message ? error.message : error) };
  }
}
