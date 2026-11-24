# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [1.3.1] — 2026-11-24

Packaging and documentation release. No behaviour change.

### Added
- `README.en.md` — a real English README; the language switch on both sides now goes somewhere.
- `docs/development.md` — the protocol pitfalls, code layout and test commands, moved out of the README.
- `docs/media/architecture.svg` and `docs/media/grouping.svg` — the README's first screen shows the data flow and the grouping behaviour instead of describing them in prose.
- `docs/media/README.md` — instructions for recording the interface GIF (slot reserved in the README).
- `.github/workflows/ci.yml` — offline suites on every push and PR.
- `.github/workflows/release.yml` — attaching a source archive and notes to a GitHub Release; optional npm publish when `NPM_TOKEN` is configured.
- `CHANGELOG.md` — this file.
- Repository `keywords` now cover the terms people actually search for (`zotero-api`, `literature-review`, `pdf`, `bibtex`, `notes-sync`).

### Changed
- README restructured: install first, then "the agent can read your library" (the daily-use half), then writing into the library. The protocol notes moved to `docs/development.md`.
- Badges now derive from the repository (`github/v/tag`, DSH 0.2.x) instead of being hand-written strings that had drifted to `0.1.5–0.1.7-rc.2`.
- Install command no longer hard-codes `--profile web`; the desktop profile is covered too.

### Fixed
- The README's `English` link pointed at an anchor that did not exist.
- The plugin market index was pinned to v1.1.1, so installing through the index silently delivered two releases behind. It is now regenerated for each release.

## [1.3.0] — 2026-11-23

### Added
- The Zotero item is now named after the document's own title instead of its filename. Resolution order: YAML front-matter `title:` → first Markdown heading → filename without extension. An explicit `title` argument still wins.
- `title.mjs` — title extraction plus `test/title.test.mjs`.

### Notes
- Only Markdown and plain text are inspected. PDF, DOCX and other binaries are not parsed; they keep the filename.

## [1.2.0] — 2026-10-30

### Added
- `groupIntoOne` (default `true`): several files uploaded in one call merge into a single Zotero item, each file stored as an attachment of it. Toggle at runtime with `/zotero group on|off` or `configure({ grouped })`.
- `saveGroup()` reuses one Connector session so the parent item is created once.

### Changed
- Behaviour change versus v1.1 and earlier, where every file produced its own item.

## [1.1.1] — 2026-10-28

### Fixed
- Attachment paths are resolved from `/items/:key/file/view/url` (plain-text local path) rather than the `/file` 302 redirect.

## [1.1.0] — 2026-10-28

### Added
- Read-only library access over the Zotero Local API: `zotero_library` tool with `search` · `item` · `fulltext` · `file` · `collections` · `tags`.
- Item detail export as BibTeX / RIS / CSL JSON.
- PDF full-text extraction from Zotero's index, and attachment absolute paths.
- `/zotero find`, `/zotero read`, `/zotero collections`.

### Notes
- Reading needs `extensions.zotero.httpServer.localAPI.enabled` (Zotero → Settings → Advanced → Miscellaneous). Uploading does not.
- Strictly read-only: GET only, no write authorisation requested.

## [1.0.0] — 2026-10-28

### Added
- First release. Uploads documents produced in a conversation into the local Zotero library through Zotero's built-in Connector (`127.0.0.1:23119`) — no account, no API key, no add-on inside Zotero, no writes to `zotero.sqlite`.
- Four entry points: the per-turn deliverables card, a batch button, a composer chip, and `/zotero` + the `zotero_sync` tool.
- Session deliverables ledger so `source: session` only ever uploads files the conversation actually produced.
- `source` (session | workspace) × `scope` (md | docs | all) configuration, layered over `cordis.patch.yml`.
- sha1 content dedupe with `--force` override.
- Offline test suites plus opt-in live suites against a real Zotero.

[Unreleased]: https://github.com/520limited/dsh-zotero-sync/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/520limited/dsh-zotero-sync/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/520limited/dsh-zotero-sync/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/520limited/dsh-zotero-sync/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/520limited/dsh-zotero-sync/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/520limited/dsh-zotero-sync/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/520limited/dsh-zotero-sync/releases/tag/v1.0.0
