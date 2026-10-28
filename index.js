/**
 * dsh-zotero-sync — Host half
 *
 * Pushes the documents this conversation produced (Markdown notes, PDFs, Office files) into
 * the local Zotero desktop library through Zotero's own built-in Connector server on
 * 127.0.0.1:23119. No Zotero account, no API key, and no add-on inside Zotero: Zotero ships
 * that HTTP server for its browser connector and this plugin speaks its protocol.
 *
 * One operation, several callers (Harness plugin practice "one operation, two callers"):
 *   - the agent tool `zotero_sync`
 *   - the human slash command `/zotero`
 *   - the Client chips, which run the same command lines through
 *     `ctx.remote.commands.execute()` so no surface can drift from another.
 * All of them land in operations.mjs.
 *
 * Engineering constraints that shaped this file:
 *   - Imports no `@deepseek-ai/*` package. Out-of-tree resolution of the dsh packages from a
 *     profile-installed bundle is unreliable, so tools are registered as raw JSON-Schema
 *     definitions and argument validation is owned here — the posture the installed modsearch
 *     bundle documents for the same reason.
 *   - Optional services ride `ctx.inject([...], fn)` so a composition without `tools`,
 *     `commands`, or `workingDirectory` still activates this plugin instead of parking its
 *     fiber on a service nobody provides.
 *   - `apply()` never throws: a throwing host half surfaces as "Failed to load plugins" and
 *     takes the UI with it.
 */
import path from 'node:path';

import { ZoteroConnector } from './zotero.mjs';
import { loadSettings, saveSettings, SCOPES, SOURCE_KEYS } from './settings.mjs';
import { collectCandidates, syncMany, describeError, tally } from './operations.mjs';
import { searchItems, itemDetail, itemFulltext, attachmentPath, listCollections, listTags, formatItemRow, EXPORT_FORMATS } from './library.mjs';

const PACKAGE_ID = 'dsh-zotero-sync';

/**
 * @param ctx - the plugin's Cordis context.
 * @param config - the Loader row's config object; every field optional (see settings.mjs).
 */
export function apply(ctx, config = {}) {
  const patch = config && typeof config === 'object' ? config : {};

  /**
   * Files each live session produced, in first-write order.
   *
   * A derived cache, not a source of truth: `tools/result` and `session/event` are observed
   * live, so an agent started before this plugin mounted (or anything from before a Host
   * restart) has an empty set — the caller then sees an honest empty list instead of files the
   * conversation never touched. The session log stays authoritative for everything else.
   */
  const produced = new Map();
  const PRODUCED_CAP = 400;
  const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

  const remember = (sessionId, target) => {
    if (!sessionId || !target || typeof target !== 'string') return;
    let bucket = produced.get(sessionId);
    if (!bucket) {
      bucket = new Set();
      produced.set(sessionId, bucket);
    }
    bucket.add(target.trim());
    if (bucket.size > PRODUCED_CAP) bucket.delete(bucket.values().next().value);
  };

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec || !WRITE_TOOLS.has(exec.name)) return;
      if (!result || result.isError) return;
      const meta = result.meta || {};
      const sessionId = exec.agent && exec.agent.session && exec.agent.session.id;
      remember(sessionId, meta.path || (exec.args && (exec.args.file_path || exec.args.path)));
    } catch (error) {
      /* observation only: bookkeeping must never disturb a tool result */
    }
  });

  // `present` is the authoritative "this file is a deliverable" declaration, and it also covers
  // files a shell command created, which no tool result names.
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'deliverables/presented') return;
      const files = (event.data && event.data.files) || [];
      for (const file of files) {
        remember(session && session.id, typeof file === 'string' ? file : file && file.path);
      }
    } catch (error) {
      /* observation only */
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent && agent.session && agent.session.id;
    if (sessionId) produced.delete(sessionId);
  });

  /** Effective settings: stored user choices win over patch defaults. */
  const settings = () => loadSettings(patch);
  const connector = () => new ZoteroConnector({ baseUrl: settings().baseUrl, timeoutMs: settings().timeoutMs });

  // `workingDirectory` is mounted by coding profiles but not by every composition, so it is
  // taken through ctx.inject rather than declared as a hard dependency. Without it, relative
  // paths resolve against the session header's cwd or this process's directory.
  let workingDirectory = null;
  if (typeof ctx.inject === 'function') {
    ctx.inject(['workingDirectory'], (scope) => {
      workingDirectory = scope.workingDirectory || null;
    });
  }

  /** The directory a session's relative paths resolve against. */
  const directoryOf = (agent, signal) => {
    if (workingDirectory && agent) return workingDirectory.ensure(agent, signal);
    const meta = agent && agent.session && agent.session.meta;
    return Promise.resolve((meta && meta.cwd) || process.cwd());
  };

  /** Paths this session produced through writes or explicit delivery. */
  const producedPaths = (agent) => {
    const sessionId = agent && agent.session && agent.session.id;
    const bucket = sessionId ? produced.get(sessionId) : undefined;
    return bucket ? [...bucket] : [];
  };

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    const ready = settings();
    ctx.logger.info(
      `[${PACKAGE_ID}] ready (zotero ${ready.baseUrl}, source ${ready.source}, scope ${ready.scope}, ` +
        `target ${ready.target || 'Zotero selection'})`,
    );
  }

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'zotero_library',
      description:
        "Search and read the user's local Zotero library, READ-ONLY (the user has granted access). Talks to Zotero's local API on 127.0.0.1:23119; Zotero must be running AND the user must have enabled Preferences → Advanced → \"Allow other applications on this computer to communicate with Zotero\" — if they did not, the error message says so and nothing else is wrong. Actions: \"search\" finds top-level items (query text, tag, itemType filter like -attachment or journalArticle, collection key); \"item\" returns one item's full metadata by its 8-character key, with attachments and notes, or an export format (bibtex|ris|csljson|...) as text; \"fulltext\" returns the extracted plain text of an item's PDF attachment (great for actually reading a paper); \"file\" returns the absolute local path of the item's attachment so you can read the file itself; \"collections\" lists collections; \"tags\" lists tags. Never creates, modifies, or deletes anything. Item keys come from search results, not from thin air.",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'item', 'fulltext', 'file', 'collections', 'tags'],
            description: 'What to do.',
          },
          query: {
            type: 'string',
            description: 'Search text (title/creator/year). Empty lists recent items.',
          },
          tag: { type: 'string', description: 'Filter by tag.' },
          itemType: {
            type: 'string',
            description: 'Zotero item type filter, e.g. "journalArticle", "book", or "-attachment" (default excludes attachments).',
          },
          collection: {
            type: 'string',
            description: '8-character collection key to search within (from the "collections" action).',
          },
          key: { type: 'string', description: '8-character item key, for item/fulltext/file.' },
          format: {
            type: 'string',
            enum: [...EXPORT_FORMATS],
            description: 'With action "item": return a citation export (bibtex, ris, csljson…) as text instead of JSON metadata.',
          },
          limit: { type: 'number', description: 'Page size, 1-100 (default 25).' },
          start: { type: 'number', description: 'Offset for paging through results.' },
          sort: {
            type: 'string',
            description: 'dateModified (default) | dateAdded | title | creator | date.',
          },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction, default desc.' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            total: { type: 'integer' },
            items: { type: 'array', items: { type: 'object' } },
            item: { type: 'object' },
            fulltext: { type: 'string' },
            path: { type: 'string' },
            text: { type: 'string' },
            collections: { type: 'array', items: { type: 'object' } },
            tags: { type: 'array', items: { type: 'object' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        void exec;
        const action = String((args && args.action) || '');
        const zot = connector();
        const base = { action, baseUrl: settings().baseUrl };
        try {
          if (action === 'search') {
            const found = await searchItems(zot, {
              query: args && args.query,
              tag: args && args.tag,
              itemType: args && args.itemType,
              collection: args && args.collection,
              limit: args && args.limit,
              start: args && args.start,
              sort: args && args.sort,
              direction: args && args.direction,
            });
            const head = found.total
              ? `找到 ${found.total} 个条目${args && args.query ? `（“${args.query}”）` : ''}${found.items.length < found.total ? `，显示 ${found.items.length} 个` : ''}：`
              : `没有匹配的条目${args && args.query ? `（“${args.query}”）` : ''}。`;
            return {
              ...base,
              ok: true,
              message: head + (found.items.length ? '\n' + found.items.map(formatItemRow).join('\n') : ''),
              total: found.total,
              items: found.items,
            };
          }
          if (action === 'item') {
            const detail = await itemDetail(zot, args && args.key, { format: args && args.format });
            if (detail.text !== undefined) {
              return { ...base, ok: true, message: `条目 ${(args.key || '').toUpperCase()} 的 ${detail.format} 导出：\n${detail.text}`, text: detail.text };
            }
            const lines = [`《${detail.title}》 (${detail.itemType}, ${detail.key})`];
            if (detail.creators.length) lines.push(`作者：${detail.creators.join('; ')}`);
            if (detail.year) lines.push(`年份：${detail.year}${detail.journal ? `｜期刊：${detail.journal}` : ''}`);
            if (detail.doi) lines.push(`DOI：${detail.doi}`);
            if (detail.abstract) lines.push(`摘要：${detail.abstract}`);
            if (detail.tags.length) lines.push(`标签：${detail.tags.join(', ')}`);
            for (const att of detail.attachments || []) lines.push(`附件：${att.key} ${att.title}${att.filename ? ` (${att.filename})` : ''}`);
            for (const note of detail.notes || []) lines.push(`笔记：${note.key} ${note.title}`);
            lines.push('提示：用 action=fulltext 读取 PDF 全文，action=file 拿本地文件路径。');
            return { ...base, ok: true, message: lines.join('\n'), item: detail };
          }
          if (action === 'fulltext') {
            const full = await itemFulltext(zot, args && args.key);
            const content = full.content;
            const shown = content.length > 40000 ? content.slice(0, 40000) + `\n…（共 ${content.length} 字符，已截断）` : content;
            return {
              ...base,
              ok: true,
              message: `《${full.attachmentTitle}》全文（${content.length} 字符）:\n${shown}`,
              fulltext: content,
            };
          }
          if (action === 'file') {
            const where = await attachmentPath(zot, args && args.key);
            return {
              ...base,
              ok: true,
              message: `附件本地路径（${where.contentType || '未知类型'}）：${where.path}`,
              path: where.path,
            };
          }
          if (action === 'collections') {
            const listed = await listCollections(zot);
            return {
              ...base,
              ok: true,
              message: `共 ${listed.total} 个分类：\n` + listed.collections.map((c) => `  ${c.key}  ${c.name}${c.itemCount != null ? ` (${c.itemCount})` : ''}`).join('\n'),
              collections: listed.collections,
            };
          }
          if (action === 'tags') {
            const listed = await listTags(zot, { query: args && args.query, limit: args && args.limit });
            return {
              ...base,
              ok: true,
              message: `共 ${listed.total} 个标签：\n` + listed.tags.map((t) => `  ${t.tag} (${t.itemCount ?? '?'})`).join('\n'),
              tags: listed.tags,
            };
          }
          throw new Error(`zotero_library: unknown action "${action}" (search | item | fulltext | file | collections | tags)`);
        } catch (error) {
          return { ...base, ok: false, message: describeError(error) };
        }
      },
    });
  });

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'zotero_sync',
      description:
        "Upload documents produced in this conversation into the user's local Zotero desktop library. Zotero must be running; this talks to its built-in connector on 127.0.0.1:23119 (no API key, no Zotero add-on). Actions: \"status\" reports reachability and the current configuration; \"targets\" lists libraries and collections as ids like L1 or C23; \"candidates\" shows which files a source+scope pair would upload; \"sync\" uploads; \"configure\" changes defaults (source = session|workspace, scope = md|docs|all, target, tags, baseUrl). Scope \"md\" means Markdown only, \"docs\" adds PDF/Office/web/ebook, \"all\" takes any file but only for source=session. Uploads are deduplicated by content hash, so re-syncing an unchanged file reports it is already in Zotero instead of creating a duplicate item. Pass set_target or set_source/set_scope with configure to persist a choice. Failures carry a bracketed reason code. Nothing is written into the workspace.",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'targets', 'candidates', 'sync', 'configure'],
            description: 'What to do.',
          },
          source: {
            type: 'string',
            enum: ['session', 'workspace'],
            description: 'Where files come from. Defaults to the configured source ("session").',
          },
          scope: {
            type: 'string',
            enum: ['md', 'docs', 'all'],
            description: 'Which file types to accept. Defaults to the configured scope ("docs").',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit file paths; overrides source. Relative paths use the session working directory.',
          },
          target: {
            type: 'string',
            description: 'Zotero treeViewID such as "L1" (a library) or "C23" (a collection).',
          },
          set_target: {
            type: 'boolean',
            description: 'Persist "target" as the remembered destination.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra Zotero tags for this call, merged with the configured ones.',
          },
          title: {
            type: 'string',
            description: 'Item title when uploading a single file. Defaults to the file name without extension.',
          },
          force: {
            type: 'boolean',
            description: 'Upload even when the same bytes are already recorded as uploaded.',
          },
          limit: {
            type: 'number',
            description: 'Cap for candidates.',
          },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            baseUrl: { type: 'string' },
            settings: { type: 'object' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string', required: true },
                  name: { type: 'string' },
                  title: { type: 'string' },
                  target: { type: 'string' },
                  attachment: { type: 'string' },
                  bytes: { type: 'integer' },
                  skipped: { type: 'boolean' },
                  reason: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
            targets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  level: { type: 'integer' },
                },
              },
            },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  name: { type: 'string' },
                  size: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const action = String((args && args.action) || '');
        const current = settings();
        const zot = connector();
        const cwd = exec && exec.agent ? await directoryOf(exec.agent, exec.signal) : process.cwd();
        const base = { action, baseUrl: current.baseUrl };

        if (action === 'status') {
          const alive = await zot.ping();
          if (!alive.ok) {
            return {
              ...base,
              ok: false,
              message: `连不上 Zotero（${current.baseUrl}），原因 ${alive.reason}。请先启动 Zotero 桌面端再试。`,
              settings: summarize(current),
            };
          }
          let where = '';
          try {
            const info = await zot.getTargets();
            where = `文库「${info.libraryName}」，目标 ${describeTarget(info, current.target)}`;
          } catch (error) {
            where = describeError(error);
          }
          return {
            ...base,
            ok: true,
            message: `Zotero 在线。${where}\n来源 ${current.source}｜范围 ${current.scope}｜标签 ${current.tags.join(', ') || '（无）'}`,
            settings: summarize(current),
          };
        }

        if (action === 'targets') {
          const info = await zot.getTargets();
          if (args && args.set_target === true && args && args.target) {
            persistTarget(String(args.target).toUpperCase(), current);
          }
          const remembered = (args && args.set_target === true && args.target ? String(args.target).toUpperCase() : '')
            || rememberedTarget(current);
          const rows = info.targets.map((t) => `  ${t.id}  ${'  '.repeat(t.level)}${t.name}`);
          return {
            ...base,
            ok: true,
            message: `Zotero 文库「${info.libraryName}」，${info.targets.length} 个可选位置：\n${rows.join('\n')}\n当前目标：${describeTarget(info, remembered)}`,
            targets: info.targets.map((t) => ({ id: t.id, name: t.name, level: t.level })),
          };
        }

        if (action === 'candidates') {
          const found = await collectCandidates({
            settings: current,
            cwd,
            source: args && args.source,
            scope: args && args.scope,
            paths: args && args.paths,
            limit: args && args.limit,
            produced: producedPaths(exec && exec.agent),
          });
          return {
            ...base,
            ok: true,
            message: found.length
              ? `找到 ${found.length} 个待上传文档：\n` + found.map((c) => `  ${c.path} (${fmtSize(c.size)})`).join('\n')
              : '没有匹配到文档。可让用户先产出文件、改用 source=workspace 扫描工作目录、或直接给 paths，也可用 configure 放宽 scope。',
            candidates: found.map((c) => ({ path: c.path, name: c.name, size: c.size })),
          };
        }

        if (action === 'sync') {
          const found = await collectCandidates({
            settings: current,
            cwd,
            source: args && args.source,
            scope: args && args.scope,
            paths: args && args.paths,
            limit: args && args.limit,
            produced: producedPaths(exec && exec.agent),
          });
          if (!found.length) {
            return { ...base, ok: false, message: '没有可上传的文档（source/scope/paths 没有匹配到真实文件）。', results: [] };
          }
          const asked = args && args.target ? String(args.target).toUpperCase() : '';
          if (args && args.set_target === true && asked) persistTarget(asked, current);
          const target = /^[LC]\d+$/u.test(asked) ? asked : rememberedTarget(current);
          const outcomes = await syncMany({
            zot,
            candidates: found,
            target,
            tags: mergeTags(args && args.tags, current),
            title: args && args.title,
            force: args && args.force === true,
            rememberTargetOnSuccess: !target,
            onSetTarget: (id) => persistTarget(id, current),
          });
          const counts = tally(outcomes);
          return {
            ...base,
            ok: counts.failCount === 0,
            message: formatOutcomes(outcomes, counts),
            results: outcomes,
          };
        }

        if (action === 'configure') {
          const written = saveSettings(configurePatch(args), current);
          if (written && written.__error) {
            return { ...base, ok: false, message: `无法写入设置文件：${written.__error}`, settings: summarize(current) };
          }
          const next = settings();
          return {
            ...base,
            ok: true,
            message:
              `已保存配置：来源 ${describeSource(next.source)}｜范围 ${describeScope(next.scope)}｜` +
              `目标 ${next.target || 'Zotero 当前位置'}｜标签 ${next.tags.join(', ') || '（无）'}`,
            settings: summarize(next),
          };
        }

        throw new Error(`zotero_sync: unknown action "${action}" (status | targets | candidates | sync | configure)`);
      },
    });
  });

  ctx.inject(['commands'], (scope) => {
    scope.commands.register({
      name: 'zotero',
      description: 'Zotero 同步与文献检索：上传本会话产出文档，或搜索/阅读文库中的文献',
      definitionId: PACKAGE_ID,
      input: { hint: '[status | targets | use <ID> | scope <md|docs|all> | source <session|workspace> | sync [路径…] [--force] | find [关键词] | read <KEY> [--bibtex|--file] | collections]' },
      handler: async ({ agent, rawInput, signal }) => {
        const parts = tokenize(rawInput);
        const verb = (parts[0] || 'status').toLowerCase();
        const current = settings();
        const zot = connector();
        try {
          if (verb === 'status' || verb === 'ping') {
            const alive = await zot.ping();
            if (!alive.ok) {
              return { kind: 'error', text: `Zotero 未响应（${alive.reason}）。请先启动 Zotero 桌面端。` };
            }
            const info = await zot.getTargets();
            return {
              kind: 'success',
              text:
                `Zotero 已连接：文库「${info.libraryName}」（${current.baseUrl}）。\n` +
                `上传目标：${describeTarget(info, rememberedTarget(current))}\n` +
                `来源：${describeSource(current.source)}｜范围：${describeScope(current.scope)}\n` +
                '接下来：/zotero targets 选集合，/zotero sync 上传。',
            };
          }

          if (verb === 'targets') {
            const info = await zot.getTargets();
            const rows = info.targets.map((t) => `${t.id}  ${'  '.repeat(t.level)}${t.name}`);
            return {
              kind: 'success',
              text: `可选位置（用 /zotero use <ID> 记住）：\n${rows.join('\n')}\n当前：${describeTarget(info, rememberedTarget(current))}`,
            };
          }

          if (verb === 'use' || verb === 'target') {
            const id = String(parts[1] || '').trim().toUpperCase();
            if (!/^[LC]\d+$/u.test(id)) {
              return { kind: 'error', text: '需要一个形如 L1 或 C23 的 ID。用 /zotero targets 列出可选位置。' };
            }
            return persistTarget(id, current)
              ? { kind: 'success', text: `已记住上传目标 ${id}。之后 /zotero sync、输入框按钮与 zotero_sync 工具都送到这里。` }
              : { kind: 'error', text: '无法写入设置文件，本次仅内存生效。' };
          }

          if (verb === 'scope') {
            const key = String(parts[1] || '').trim().toLowerCase();
            if (!Object.keys(SCOPES).includes(key)) {
              return { kind: 'error', text: '范围可选：md（只要 Markdown）、docs（Markdown+PDF+Office）、all（本会话所有产出文件）。' };
            }
            return writePatch({ scope: key }, current, `上传范围已设为 ${describeScope(key)}`);
          }

          if (verb === 'source') {
            const key = String(parts[1] || '').trim().toLowerCase();
            if (!SOURCE_KEYS.includes(key)) {
              return { kind: 'error', text: '来源可选：session（只传本会话产出的文件）、workspace（扫描工作目录）。' };
            }
            return writePatch({ source: key }, current, `文件来源已设为 ${describeSource(key)}`);
          }

          if (verb === 'sync' || verb === 'upload' || verb === 'here') {
            const explicit = parts.slice(1).filter((p) => !p.startsWith('--'));
            const force = parts.includes('--force');
            const cwd = agent ? await directoryOf(agent, signal) : process.cwd();
            const found = await collectCandidates({
              settings: current,
              cwd,
              // explicit paths take precedence inside collectCandidates; source only matters when
              // the user named nothing.
              source: current.source,
              paths: explicit.length ? explicit : undefined,
              produced: producedPaths(agent),
            });
            if (!found.length) {
              return {
                kind: 'error',
                text:
                  '这个会话还没有可上传的文档。可以：显式指定路径 /zotero sync notes/a.md；' +
                  '或扫描工作目录 /zotero source workspace 后再 sync。',
              };
            }
            const outcomes = await syncMany({
              zot,
              candidates: found,
              target: rememberedTarget(current),
              tags: mergeTags(undefined, current),
              force,
              rememberTargetOnSuccess: true,
              onSetTarget: (id) => persistTarget(id, current),
            });
            const counts = tally(outcomes);
            const text = formatOutcomes(outcomes, counts);
            return counts.failCount && !counts.okCount ? { kind: 'error', text } : { kind: 'success', text };
          }

          if (verb === 'find' || verb === 'search') {
            const query = parts.slice(1).join(' ').trim();
            const found = await searchItems(zot, { query: query || undefined, limit: 15 });
            if (!found.items.length) return { kind: 'success', text: `文库中没有匹配「${query || '（最近条目）'}」的条目。` };
            return {
              kind: 'success',
              text: `找到 ${found.total} 个条目：\n` + found.items.map(formatItemRow).join('\n') + '\n用 /zotero read <KEY> 看详情或读 PDF 全文。',
            };
          }

          if (verb === 'read') {
            const key = String(parts[1] || '').trim().toUpperCase();
            if (!/^[A-Z0-9]{8}$/u.test(key)) {
              return { kind: 'error', text: '用法：/zotero read <8位条目key>（先用 /zotero find 查到 key）。' };
            }
            if (parts.includes('--bibtex')) {
              const exported = await itemDetail(zot, key, { format: 'bibtex' });
              return { kind: 'success', text: exported.text };
            }
            if (parts.includes('--file')) {
              const where = await attachmentPath(zot, key);
              return { kind: 'success', text: `附件本地路径：${where.path}` };
            }
            const full = await itemFulltext(zot, key);
            const content = full.content.length > 12000 ? full.content.slice(0, 12000) + `\n…（全文 ${full.content.length} 字符，已截断；让 Agent 用 zotero_library 工具读完整版）` : full.content;
            return { kind: 'success', text: `《${full.attachmentTitle}》全文：\n${content}` };
          }

          if (verb === 'collections' || verb === 'cols') {
            const listed = await listCollections(zot);
            return {
              kind: 'success',
              text: `Zotero 分类（${listed.total}）：\n` + listed.collections.map((c) => `  ${c.key}  ${c.name}${c.itemCount != null ? ` (${c.itemCount})` : ''}`).join('\n'),
            };
          }

          return {
            kind: 'error',
            text: `未知子命令 /zotero ${verb}。可用：status、targets、use <ID>、scope <md|docs|all>、source <session|workspace>、sync [路径…] [--force]、find [关键词]、read <KEY> [--bibtex|--file]、collections。`,
          };
        } catch (error) {
          return { kind: 'error', text: describeError(error) };
        }
      },
    });
  });
}

/* ── settings access, kept in one place so every surface persists identically ── */

/**
 * Split a command line into words, honoring "quoted arguments" and 'single quoted'.
 * Windows paths are full of spaces, so `/zotero sync "D:\我的笔记\a.md"` has to survive.
 * @param raw - everything after the command name.
 */
function tokenize(raw) {
  const text = String(raw || '');
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        current += text[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

function rememberedTarget(current) {
  const value = String(current.target || '');
  return /^[LC]\d+$/u.test(value) ? value : '';
}

function persistTarget(id, current) {
  return writeOk(saveSettings({ target: id }, current));
}

function writePatch(patch, current, okText) {
  return writeOk(saveSettings(patch, current))
    ? { kind: 'success', text: okText }
    : { kind: 'error', text: '无法写入设置文件，本次仅内存生效。' };
}

function writeOk(saved) {
  return !(saved && saved.__error);
}

function configurePatch(args) {
  const out = {};
  if (args && typeof args.scope === 'string' && Object.keys(SCOPES).includes(args.scope.toLowerCase())) {
    out.scope = args.scope.toLowerCase();
  }
  if (args && typeof args.source === 'string' && SOURCE_KEYS.includes(args.source.toLowerCase())) {
    out.source = args.source.toLowerCase();
  }
  if (args && args.target && /^[LC]\d+$/u.test(String(args.target))) out.target = String(args.target).toUpperCase();
  if (args && Array.isArray(args.tags)) out.tags = args.tags;
  if (args && typeof args.baseUrl === 'string' && /^https?:\/\//iu.test(args.baseUrl)) out.baseUrl = args.baseUrl;
  return out;
}

function mergeTags(extra, current) {
  const base = Array.isArray(current.tags) ? current.tags : [];
  const more = Array.isArray(extra) ? extra : [];
  return [...new Set([...base, ...more].map((t) => String(t).trim()).filter(Boolean))];
}

function summarize(current) {
  return {
    baseUrl: current.baseUrl,
    source: current.source,
    scope: current.scope,
    target: current.target,
    tags: current.tags,
    workspaceLimit: current.workspaceLimit,
  };
}

function describeScope(scope) {
  return { md: '只要 Markdown', docs: 'Markdown + PDF + Office + 网页', all: '所有类型（限本会话产出）' }[scope] || scope;
}

function describeSource(source) {
  return source === 'workspace' ? '扫描工作目录' : '本会话产出的文件';
}

function describeTarget(info, target) {
  if (!target) return `Zotero 当前选中的位置（${info.currentTarget} ${info.currentName || ''}）`;
  const hit = info.targets.find((t) => t.id === target);
  if (!hit) return `${target}（不在当前列表中，上传前先用 /zotero targets 核对）`;
  return `${hit.id} ${hit.name}`;
}

function formatOutcomes(outcomes, { okCount, skippedCount, failCount }) {
  const lines = outcomes.map((o) => {
    if (o.error) return `✗ ${shortPath(o.file)}\n    ${o.error}`;
    if (o.skipped) return `＝ ${shortPath(o.file)}\n    ${o.reason}`;
    return `✓ ${shortPath(o.file)} → 《${o.title}》附件「${o.attachment}」位置 ${o.target}`;
  });
  const head =
    failCount === 0
      ? okCount
        ? `已上传 ${okCount} 个文件到 Zotero${skippedCount ? `，${skippedCount} 个内容未变化跳过` : ''}。`
        : `${skippedCount} 个文件内容未变化，已在 Zotero 中（需要重复上传用 --force）。`
      : `成功 ${okCount} 个，跳过 ${skippedCount} 个，失败 ${failCount} 个。`;
  return head + '\n' + lines.join('\n');
}

function shortPath(value) {
  const text = String(value || '');
  const cwd = process.cwd();
  if (path.isAbsolute(text) && text.startsWith(cwd)) {
    const rel = text.slice(cwd.length).replace(/^[\\/]+/u, '');
    if (rel) return rel;
  }
  return text;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export const name = PACKAGE_ID;
