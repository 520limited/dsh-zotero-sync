# dsh-zotero-sync

把 **DSH 对话中产出的文档**（Markdown 笔记、PDF、Office 文件）一键同步到本机 **Zotero 桌面端文库**。

直连 Zotero 自带的 Connector 服务（`127.0.0.1:23119`）——**不需要 Zotero 账号、不需要 API key、不需要在 Zotero 里装任何插件**。

## 三个入口，一个操作

| 入口 | 用法 |
|---|---|
| Agent 工具 `zotero_sync` | 对话里直接说"把这份笔记存到 Zotero" |
| 斜杠命令 `/zotero` | `status` · `targets` · `use <ID>` · `sync [路径…] [--force]` |
| 输入框胶囊按钮 | 客户端 composer 上的「上传文档到 Zotero」，走同一条 `/zotero sync` |

## 工具 actions（agent 侧）

`status` 连通性与配置 · `targets` 列出文库/集合（`L1`/`C23`）· `candidates` 预览将上传的文件 · `sync` 上传 · `configure` 改默认值（source/scope/target/tags/baseUrl）

## 核心行为

- **来源 source**：`session`（默认）只上传本会话写出/`present` 的文件——通过观察 `tools/result`（write/edit）与 `session/event`（`deliverables/presented`）建立账本，绝不静默上传对话没碰过的文件；`workspace` 扫描工作目录（限深限数）。
- **范围 scope**：`md` 仅 Markdown；`docs`（默认）加 PDF/Office/网页/电子书；`all` 不限类型（仅 session 来源）。
- **去重**：按内容 sha1 记录上传历史，未变化的文件第二次 sync 报告"已在 Zotero"而不是重复建条目；`force` 可强推。
- **目标记忆**：首次成功上传后记住落点；`/zotero use C23` 手动指定。
- 条目类型为 `document`，标签默认 `DSH对话笔记`，`libraryCatalog` 显示 `DeepSeek Harness`。

## 安装

```bash
# 方式一：源码目录本地链接（开发）
cd ~/.dsh/profiles/desktop
pnpm add file:D:/PostGra/DSH_workspace/dsh-zotero-sync
# bundle 列表加入 dsh-zotero-sync（package.json 的 dsh.profile.bundles）

# 方式二：npm 包（发布后）
dsh plugin --profile desktop add dsh-zotero-sync
```

包自带 `cordis.patch.yml`（`dsh.bundle.patch`），走 bundle 渠道安装时会自动 insert 进 boot graph，无需手改 profile 补丁。

## 配置（cordis.patch.yml 的 config 层，或运行时 settings.json）

`baseUrl` · `scope` · `source` · `tags` · `target` · `workspaceLimit` · `workspaceDepth` · `maxFileBytes` · `extensions`

层叠优先级：调用参数 > 存储文件（`plugin-data/dsh-zotero-sync/settings.json`）> patch config > 内置默认。

## 协议要点（踩坑记录，见 zotero.mjs 头注释）

1. 必须带 `X-Zotero-Connector-API-Version: 3` 且 UA 非浏览器形状，否则被拒。
2. `saveItems` 的 payload **不能带 `proxy: {}`**——空对象也会让 Zotero 构造 `new Zotero.Proxy({})` 而 500。
3. 附件走 `saveAttachment` 原始流：Content-Type 不能是纯文本类型（`.txt` 需改标 `application/octet-stream`，`.md` 保留 `text/markdown` 可预览）。
4. `X-Metadata` 头按 latin-1 传输，非 ASCII 一律 `\uXXXX` 转义，中文标题才能无损往返。
5. 保存会话约 10 分钟过期（`SESSION_NOT_FOUND` → 提示重试）。

## 测试

```bash
node test/deliverables.test.mjs   # 离线：session 事件账本 → candidates 全链路
```

## 要求

- Zotero 桌面端运行中（6.x+ 实测，Zotero 7 的 Connector 协议兼容）
- Node ≥ 18（需要全局 fetch）
