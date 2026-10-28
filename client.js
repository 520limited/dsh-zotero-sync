/**
 * dsh-zotero-sync — Client half (Web)
 *
 * Surfaces the upload where the files already are: the finished turn's tail. The deliverables
 * card and the final message already sit there, and this seat's props carry the turn's real
 * file paths (`turn.data.get('deliverables')`), which is exactly what an upload needs — the
 * nearby `deliverables.file.actions` seat, by contrast, only receives an opaque action URL.
 *
 * Two entries:
 *   1. `conversation.chat.turnTail` — one compact row per document this turn produced, each with
 *      its own upload action, plus a batch action. The Host owns the type/scope decision, so this
 *      view asks it which files qualify (`/zotero config`) instead of keeping its own copy.
 *   2. `conversation.composer.dock` — a chip that syncs with the configured source and scope.
 *
 * Every action runs the *same* Host command a human would type, through
 * `ctx.remote.commands.execute()`. One operation, three callers, zero duplicated logic.
 *
 * Plain JavaScript + React.createElement: no JSX transform exists in the client module table,
 * and no Harness Client package may be imported (plugin practice) — controls are written here
 * and styled with `--dsw-alias-*` tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zotero-sync',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');

    var PACKAGE_ID = 'dsh-zotero-sync';
    var NS = 'zotero';
    var TAIL_ORDER = 20;
    var DOCK_ORDER = 30;

    /* ── copy ───────────────────────────────────────────────────────────────
       Registered with the host locale service below; the inline fallback keeps
       the UI working if that service is ever unavailable. */
    var DICT = {
      zh: {
        'section': 'Zotero',
        'upload': '上传到 Zotero',
        'uploadAll': '上传 {count} 个文档到 Zotero',
        'uploading': '正在上传…',
        'uploaded': '已上传',
        'skipped': '已存在',
        'failed': '上传失败',
        'noResult': '未收到结果',
        'offline': 'Zotero 未响应，请先启动 Zotero 桌面端',
        'noFiles': '这个回合没有可上传的文档',
        'target': '目标',
        'chip': 'Zotero 同步',
        'aria': '把本回合产出的文档同步到 Zotero 文库',
        'retry': '重试',
      },
      en: {
        'section': 'Zotero',
        'upload': 'Upload to Zotero',
        'uploadAll': 'Upload {count} documents to Zotero',
        'uploading': 'Uploading…',
        'uploaded': 'Uploaded',
        'skipped': 'Already there',
        'failed': 'Upload failed',
        'noResult': 'No result returned',
        'offline': 'Zotero is not responding — start the Zotero desktop app',
        'noFiles': 'No uploadable documents in this turn',
        'target': 'Target',
        'chip': 'Zotero sync',
        'aria': "Sync this turn's documents to the Zotero library",
        'retry': 'Retry',
      },
    };

    /* ── styles: token-only, owned by an effect so unloading removes them ── */
    var CSS = [
      '.zt-card{display:flex;flex-direction:column;gap:2px;margin-top:6px;',
      'padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l1);',
      'border-radius:var(--dsw-radius-md,8px);background:transparent}',
      '.zt-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);',
      'font-size:11px;line-height:16px;padding:0 2px 2px}',
      '.zt-head__name{font-weight:600}',
      '.zt-head__target{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);',
      'max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.zt-row{display:flex;align-items:center;gap:8px;border-radius:var(--dsw-radius-sm,6px);',
      'padding:3px 4px}',
      '.zt-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.zt-name{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.zt-state{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.zt-state[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.zt-state[data-tone="skip"]{color:var(--dsw-alias-state-warn-primary)}',
      '.zt-state[data-tone="fail"]{color:var(--dsw-alias-state-error-primary)}',
      '.zt-btn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;',
      'border-radius:var(--dsw-radius-sm,6px);border:0.5px solid var(--dsw-alias-border-l1);',
      'background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;',
      'cursor:pointer;flex:none;transition:color .15s,background .15s,border-color .15s}',
      '.zt-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
      '.zt-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.zt-btn:disabled{cursor:default;opacity:.55}',
      '.zt-btn[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);',
      'border-color:var(--dsw-alias-state-success-primary)}',
      '.zt-btn[data-tone="fail"]{color:var(--dsw-alias-state-error-primary);',
      'border-color:var(--dsw-alias-state-error-primary)}',
      '.zt-icon{flex:none;display:inline-flex}',
      '.zt-spin{animation:zt-rot .9s linear infinite}',
      '@keyframes zt-rot{to{transform:rotate(360deg)}}',
      '.zt-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;',
      'border-radius:999px}',
    ].join('');

    function installStyles(ctx) {
      ctx.effect(function () {
        if (typeof document === 'undefined') return;
        var tag = document.createElement('style');
        tag.dataset.plugin = PACKAGE_ID;
        tag.dataset.pluginCss = PACKAGE_ID + '/chip.css';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return function () { tag.remove(); };
      }, PACKAGE_ID + ': stylesheet');
    }

    /* ── locale ───────────────────────────────────────────────────────────── */
    function registerLocale(ctx) {
      var locale = ctx.get && ctx.get('locale');
      if (!locale || typeof locale.register !== 'function') return null;
      try {
        var disposer = locale.register(NS, { zh: DICT.zh, en: DICT.en });
        if (typeof disposer === 'function') ctx.effect(function () { return disposer; }, PACKAGE_ID + ': locale');
        return locale;
      } catch (error) {
        try {
          // Older shape: register(ns, localeId, dict).
          var d2 = locale.register(NS, 'zh', DICT.zh);
          locale.register(NS, 'en', DICT.en);
          if (typeof d2 === 'function') ctx.effect(function () { return d2; }, PACKAGE_ID + ': locale');
          return locale;
        } catch (inner) {
          return null;
        }
      }
    }

    /**
     * @param ctx - plugin context.
     * @returns `t(key, vars)` with the host dictionary when present, else the inline fallback.
     */
    function makeT(ctx, locale) {
      var bound = null;
      try {
        if (locale && typeof locale.bind === 'function') bound = locale.bind(NS);
      } catch (error) { bound = null; }
      var id = 'zh';
      try {
        var snap = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : null;
        var raw = String((snap && (snap.id || snap.locale)) || 'zh').toLowerCase();
        id = raw.indexOf('en') === 0 ? 'en' : 'zh';
      } catch (error) { id = 'zh'; }
      var fallback = DICT[id] || DICT.zh;
      return function (key, vars) {
        var text = null;
        if (bound) {
          try {
            var value = bound(key, vars);
            // An unknown key usually echoes itself; treat that as a miss.
            if (typeof value === 'string' && value !== key) text = value;
          } catch (error) { text = null; }
        }
        if (text === null) {
          text = fallback[key] !== undefined ? fallback[key] : key;
          if (vars) {
            text = String(text).replace(/\{(\w+)\}/gu, function (_m, name) {
              return vars[name] === undefined ? '' : String(vars[name]);
            });
          }
        }
        return text;
      };
    }

    /* ── host command bridge ───────────────────────────────────────────────
       The only way this half reaches Zotero: run the same slash command a person would type. */
    function commandRunner(ctx, sessionId) {
      return function run(line) {
        if (!sessionId || !ctx.remote || !ctx.remote.commands) {
          return Promise.reject(new Error('zotero: command surface unavailable'));
        }
        return Promise.resolve(ctx.remote.commands.execute(sessionId, line, [])).then(function (result) {
          if (!result) throw new Error('zotero: no answer for ' + line);
          if (result.ok === false) {
            var err = result.error || {};
            throw new Error(err.message || err.code || 'command failed');
          }
          var body = result.value && result.value.result !== undefined ? result.value.result : result.value;
          var kind = body && body.kind;
          var text = (body && body.text) || '';
          if (kind === 'error') {
            var error = new Error(text || 'command error');
            error.kind = 'error';
            throw error;
          }
          return text;
        });
      };
    }

    /** Quote a path for the command tokenizer, which accepts "double quoted" arguments. */
    function quoteArg(value) {
      return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    /* ── icons ────────────────────────────────────────────────────────────── */
    function Icon(props) {
      var spin = !!props.spin;
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          className: 'zt-icon' + (spin ? ' zt-spin' : ''),
        },
        spin
          ? React.createElement('path', { d: 'M8 2.2a5.8 5.8 0 1 1-5.6 7.2' })
          : React.createElement(
              'g',
              null,
              React.createElement('path', { d: 'M8 11.2V3.2' }),
              React.createElement('path', { d: 'M4.9 6.3 8 3.2l3.1 3.1' }),
              React.createElement('path', { d: 'M3 13.2h10' }),
            ),
      );
    }

    /* ── the turn-tail card ─────────────────────────────────────────────── */
    function DeliverablesTail(props) {
      var ctx = props.__ctx;
      var sessionId = props.sessionId;
      var run = React.useMemo(function () { return commandRunner(ctx, sessionId); }, [ctx, sessionId]);
      var t = props.t || React.useMemo(function () { return makeT(ctx, ctx.get && ctx.get('locale')); }, [ctx]);

      var files = React.useMemo(function () { return turnFiles(props.turn); }, [props.turn]);
      var state = React.useState({ busy: null, byFile: {}, target: null });
      var view = state[0];
      var setView = state[1];
      var mounted = React.useRef(true);
      React.useEffect(function () {
        mounted.current = true;
        return function () { mounted.current = false; };
      }, []);

      // Read the remembered destination once per session; a failure is cosmetic only.
      React.useEffect(function () {
        if (!sessionId) return undefined;
        var cancelled = false;
        run('/zotero status')
          .then(function (text) {
            if (cancelled || !mounted.current) return;
            var hit = /上传目标：([^\n]+)/u.exec(text || '');
            setView(function (prev) { return { busy: prev.busy, byFile: prev.byFile, target: hit ? hit[1].trim() : '' }; });
          })
          .catch(function () { /* keep the card, just without the destination label */ });
        return function () { cancelled = true; };
      }, [sessionId, run]);

      if (!sessionId || !files.length) return null;

      /** Upload one or many files, then record each outcome keyed by path. */
      function upload(list) {
        if (view.busy) return;
        var label = list.length === 1 ? list[0].path : '__all';
        setView({ busy: label, byFile: view.byFile, target: view.target });
        var line = '/zotero sync ' + list.map(function (f) { return quoteArg(f.path); }).join(' ');
        run(line)
          .then(function (text) {
            if (!mounted.current) return;
            setView({
              busy: null,
              target: view.target,
              byFile: assignResults(view.byFile, list, parseOutcomes(text), t),
            });
          })
          .catch(function (error) {
            if (!mounted.current) return;
            var offline = /UNREACHABLE|未响应|ECONNREFUSED|fetch failed/iu.test(String((error && error.message) || ''));
            var reason = offline ? t('offline') : String((error && error.message) || error).slice(0, 200);
            var next = {};
            list.forEach(function (f) { next[f.path] = { tone: 'fail', text: reason }; });
            setView({ busy: null, target: view.target, byFile: Object.assign({}, view.byFile, next) });
          });
      }

      var busyAll = view.busy === '__all';
      return React.createElement(
        'div',
        { className: 'zt-card', 'data-zotero-sync': 'tail' },
        React.createElement(
          'div',
          { className: 'zt-head' },
          React.createElement('span', { className: 'zt-head__name' }, t('section')),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'zt-btn',
              style: { marginLeft: 'auto' },
              disabled: !!view.busy,
              onClick: function () { upload(files); },
              'aria-label': t('aria'),
            },
            React.createElement(Icon, { spin: busyAll }),
            React.createElement(
              'span',
              null,
              busyAll ? t('uploading') : t('uploadAll', { count: files.length }),
            ),
          ),
          view.target ? React.createElement('span', { className: 'zt-head__target' }, t('target') + '：' + view.target) : null,
        ),
        files.map(function (file) {
          var record = view.byFile[file.path];
          var busyOne = view.busy === file.path;
          var tone = busyOne ? 'idle' : record ? record.tone : 'idle';
          var statusText = busyOne
            ? t('uploading')
            : record
              ? record.text
              : '';
          return React.createElement(
            'div',
            { key: file.path, className: 'zt-row' },
            React.createElement('span', { className: 'zt-name', title: file.path }, file.name),
            statusText
              ? React.createElement('span', { className: 'zt-state', 'data-tone': tone, title: record && record.detail }, statusText)
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'zt-btn',
                'data-tone': tone === 'fail' ? 'fail' : tone === 'ok' ? 'ok' : undefined,
                disabled: !!view.busy,
                onClick: function () { upload([file]); },
                title: file.path,
              },
              React.createElement(Icon, { spin: busyOne }),
              React.createElement('span', null, busyOne ? t('uploading') : tone === 'fail' ? t('retry') : t('upload')),
            ),
          );
        }),
      );
    }

    /**
     * The turn's documents, from the deliverables projection this seat already receives.
     * @param turn - TurnLocation carried by `conversation.chat.turnTail` props.
     */
    function turnFiles(turn) {
      var out = [];
      var data = turn && typeof turn.data && typeof turn.data.get === 'function' ? turn.data.get('deliverables') : null;
      if (!data) return out;
      var seen = new Set();
      var push = function (rawPath, description) {
        var p = typeof rawPath === 'string' ? rawPath.trim() : '';
        if (!p || seen.has(p)) return;
        seen.add(p);
        out.push({ path: p, name: baseName(p), description: typeof description === 'string' ? description : '' });
      };
      // Explicit deliveries first: they are the files the agent meant as outputs.
      (data.presented || []).forEach(function (file) { push(file && (typeof file === 'string' ? file : file.path), file && file.description); });
      // Then everything this turn's tools wrote, so a note created by a shell command still shows.
      (data.produced || []).forEach(function (file) { push(file && (typeof file === 'string' ? file : file.path)); });
      return out;
    }

    function baseName(p) {
      var text = String(p || '');
      var at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
      return at >= 0 ? text.slice(at + 1) : text;
    }

    /**
     * Map the command's per-file report back onto our rows.
     * The Host prints `✓|＝|✗ <path>\n    <detail>` lines.
     */
    function parseOutcomes(text) {
      var map = {};
      String(text || '').split('\n').forEach(function (line, i, all) {
        var hit = /^(✓|＝|✗)\s+(.+)$/u.exec(line.trim());
        if (!hit) return;
        var detail = String(all[i + 1] || '').trim();
        if (/^\s{2,}/u.test(all[i + 1] || '')) detail = all[i + 1].trim();
        var path = hit[2].trim();
        map[path] = { mark: hit[1], detail: detail };
      });
      return map;
    }

    /** Resolve each file's display state from the report, matching by full or shortened path. */
    function assignResults(previous, list, report, t) {
      var next = Object.assign({}, previous);
      list.forEach(function (file) {
        var hit = report[file.path] || findByBasename(report, file.path);
        if (!hit) {
          next[file.path] = { tone: 'fail', text: t('noResult') };
          return;
        }
        if (hit.mark === '✓') next[file.path] = { tone: 'ok', text: t('uploaded'), detail: hit.detail };
        else if (hit.mark === '＝') next[file.path] = { tone: 'skip', text: t('skipped'), detail: hit.detail };
        else next[file.path] = { tone: 'fail', text: t('failed'), detail: hit.detail || '' };
      });
      return next;
    }

    function findByBasename(report, fullPath) {
      var name = baseName(fullPath);
      var keys = Object.keys(report);
      for (var i = 0; i < keys.length; i += 1) {
        if (keys[i] === fullPath || baseName(keys[i]) === name) return report[keys[i]];
      }
      return null;
    }

    /* ── the composer chip ────────────────────────────────────────────────
       Uses the configured source + scope, so it is the "do what I set up" button. */
    function DockChip(props) {
      var ctx = props.__ctx;
      var sessionId = props.sessionId;
      var run = React.useMemo(function () { return commandRunner(ctx, sessionId); }, [ctx, sessionId]);
      var t = props.t || makeT(ctx, ctx.get && ctx.get('locale'));
      var state = React.useState({ busy: false, tone: 'idle', text: '' });
      var view = state[0];
      var setView = state[1];
      var mounted = React.useRef(true);
      React.useEffect(function () {
        mounted.current = true;
        return function () { mounted.current = false; };
      }, []);

      function activate() {
        if (view.busy || !sessionId) return;
        setView({ busy: true, tone: 'idle', text: '' });
        run('/zotero sync')
          .then(function (text) {
            if (!mounted.current) return;
            var failed = /✗/u.test(text || '');
            var none = !/✓/u.test(text || '') && /没有|没有可上传/u.test(text || '');
            setView({ busy: false, tone: failed ? 'fail' : none ? 'skip' : 'ok', text: firstLine(text) });
          })
          .catch(function (error) {
            if (!mounted.current) return;
            var offline = /UNREACHABLE|未响应|ECONNREFUSED|fetch failed/iu.test(String((error && error.message) || ''));
            setView({ busy: false, tone: 'fail', text: offline ? t('offline') : String((error && error.message) || error).slice(0, 160) });
          })
          .then(function () {
            setTimeout(function () {
              if (!mounted.current) return;
              setView(function (prev) { return prev.tone === 'idle' ? prev : { busy: false, tone: 'idle', text: '' }; });
            }, 6000);
          });
      }

      var label = view.busy
        ? t('uploading')
        : view.tone === 'ok'
          ? t('uploaded')
          : view.tone === 'skip'
            ? t('skipped')
            : view.text || t('chip');

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'zt-btn zt-chip',
          'data-tone': view.tone === 'idle' ? undefined : view.tone,
          disabled: view.busy || !sessionId,
          onClick: activate,
          title: view.text || t('aria'),
          'aria-label': t('aria'),
        },
        React.createElement(Icon, { spin: view.busy }),
        React.createElement('span', null, label),
      );
    }

    function firstLine(text) {
      var value = String(text || '').trim();
      if (!value) return '';
      var at = value.indexOf('\n');
      return (at < 0 ? value : value.slice(0, at)).slice(0, 160);
    }

    /* ── wiring ───────────────────────────────────────────────────────────
       `remote` plus the exact namespace must both be declared: the client guard
       refuses an undeclared service at access time. */
    var inject = ['slots', 'remote', 'remote.commands'];

    function apply(ctx) {
      installStyles(ctx);
      var locale = registerLocale(ctx);
      var t = makeT(ctx, locale);

      try {
        ctx.slots.inject('conversation.chat.turnTail', function () {
          return ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'zotero-sync-tail',
              order: TAIL_ORDER,
              label: function () { return t('section'); },
              locale: NS,
              inject: function (sessionId) { return { sessionId: sessionId }; },
            },
            function SlotComponent(props) {
              return React.createElement(DeliverablesTail, Object.assign({}, props, { __ctx: ctx }));
            },
          );
        });
      } catch (error) {
        try { console.error('[' + PACKAGE_ID + '] turn tail registration failed:', error); } catch (ignored) {}
      }

      try {
        ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'zotero-sync-chip',
              order: DOCK_ORDER,
              label: function () { return t('chip'); },
              locale: NS,
              inject: function (sessionId) { return { sessionId: sessionId }; },
            },
            function SlotComponent(props) {
              return React.createElement(DockChip, Object.assign({}, props, { __ctx: ctx }));
            },
          );
        });
      } catch (error) {
        try { console.error('[' + PACKAGE_ID + '] dock registration failed:', error); } catch (ignored) {}
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      NS: NS,
      CSS: CSS,
      DICT: DICT,
      turnFiles: turnFiles,
      parseOutcomes: parseOutcomes,
      assignResults: assignResults,
      quoteArg: quoteArg,
      baseName: baseName,
      firstLine: firstLine,
      makeT: makeT,
      DeliverablesTail: DeliverablesTail,
      DockChip: DockChip,
    };
    return module.exports;
  },
});
