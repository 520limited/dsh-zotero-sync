<center>
<pre>
# dsh-zotero-sync
</pre>
</center>

> DeepSeek Harness 插件：把 **AI 对话中产出的文档**（Markdown 笔记、PDF、Office 文件）一键上传到本机 **Zotero** 桌面端文库；也能**反向读取文库**——搜索文献、读元数据、提取 PDF 全文、导出 BibTeX。
>
> A DeepSeek Harness plugin that syncs documents produced in your AI conversations into your local Zotero library — and reads your library back: search, metadata, PDF full text, BibTeX export. No account, no API key, nothing to install inside Zotero.

![License](https://img.shields.io/badge/License-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-0-556b2f?logo=npm)
![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Zotero](https://img.shields.io/badge/Zotero-10.x-red?logo=zotero&logoColor=white)
![Protocol](https://img.shields.io/badge/Connector%20protocol-verified-orange)
![Platform](https://img.shields.io/badge/DeepSeek%20Harness-default-4B32C3?logo=deepseek)
![Status](https://img.shields.io/badge/status-stable-brightgreen)

## 它解决什么问题

用 DSH（或任何 Agent）做文献精读、写笔记时，产出散落在会话里：这轮一篇 `.md`，那轮一份分析文档。想整理进 Zotero 就得手动拖文件、建条目、配附件。

装上这个插件后，**每轮对话结束时，回合尾部的交付物卡片下方会出现一个 Zotero 上传区**：本回合产出的每个文档一行，逐个传或一键全传。攒了很多轮之后，输入框下方还有一个「Zotero 同步」胶囊，按你配置的来源和范围把整个会话的文档一次收进文库。

全程只在**你点击上传的那一刻**才连接 Zotero——平时零请求。

## 工作原理

直连 Zotero 自带的本地 Connector 服务（`http://127.0.0.1:23119`，就是浏览器 Zotero Connector 用的那个）。

- ✅ 不需要 Zotero 账号、不需要 API Key
- ✅ 不需要在 Zotero 里安装任何扩展
- ✅ 不碰 `zotero.sqlite`，不依赖 Zotero 重启
- ⚠️ 唯一前提：Zotero 桌面端处于运行状态（6.x / 7.x / 8.x / 9.x / 10.x 的 Connector 协议一致，已在 Zotero 10.0.6 实测）

每个文件创建为一个 `document` 条目（标题 = 文件名或你指定的标题，`libraryCatalog` 显示 `DeepSeek Harness`），原文件作为附件流式写入 Zotero storage，中文/emoji 文件名与标题无损往返。

## 四个入口，一个操作

| 入口 | 位置 | 范围 |
|---|---|---|
| 单文件按钮 | 回合尾部 Zotero 卡片，每行右侧 | 那一个文件 |
| 批量按钮 | 同一卡片右上角 | 本回合产出的全部文档 |
| 「Zotero 同步」胶囊 | 输入框下方 | 整个会话按配置筛出的文件 |
| `/zotero` 指令 + `zotero_sync` 工具 | 输入框 / Agent 自动调用 | 全部能力 |

四个入口执行的是同一份 Host 实现，行为完全一致。你也可以直接用自然语言：*“把刚才那份笔记传到 Zotero”*。

### 斜杠指令

```
/zotero status                 连通性、当前目标与配置
/zotero targets                列出所有文库和集合（形如 L1 / C23）
/zotero use C23                记住目标集合，之后所有上传都送到这里
/zotero scope md               设置文件类型范围（md | docs | all）
/zotero source workspace       设置文件来源（session | workspace）
/zotero sync                   按当前配置上传
/zotero sync "D:\笔记\a.md"    显式指定文件（支持空格与中文路径）
/zotero sync --force           忽略去重记录，强制重传
/zotero find 超声              搜索文库（标题/作者/年份）
/zotero read ABCD1234          读条目 PDF 全文（--bibtex 导引文，--file 拿路径）
/zotero collections            列出文库分类
```

### Agent 工具 `zotero_sync`

`action` 取值：`status` · `targets` · `candidates`（预览将上传的文件）· `sync` · `configure`。
Agent 侧同样受配置约束，不会越权上传你没见过的文件。

## 读取文库（v1.1.0 新增）

除了往 Zotero 里写，插件还能**只读**访问你的文库——让 Agent 直接「看」你收藏了什么文献：

| 动作 | 说明 |
|---|---|
| 搜索条目 | 按关键词/标签/条目类型/分类检索，返回标题、作者、年份、期刊 |
| 条目详情 | 完整元数据 + 附件/笔记列表；可导出 **BibTeX / RIS / CSL JSON** 等引文格式 |
| **PDF 全文** | 提取附件的全文文本（Zotero 全文索引），Agent 可直接精读论文内容 |
| 附件路径 | 返回 PDF 在本机的绝对路径，Agent 可用文件工具直接读原文件 |
| 分类/标签 | 列出所有分类与标签，方便圈定检索范围 |

指令侧：`/zotero find [关键词]`、`/zotero read <KEY>`（`--bibtex` 导引文、`--file` 拿路径）、`/zotero collections`。
工具侧：`zotero_library`（actions: `search` · `item` · `fulltext` · `file` · `collections` · `tags`）。

典型用法：*“在我 Zotero 里找超声标准切面相关的论文，读一下 2024 年那篇的方法部分，用 APA 引用它。”* —— Agent 会 search → fulltext → 用引用格式回答，全程只读。

**一次性前提**：读取走 Zotero 的 Local API，Zotero 默认关闭它。请在 **Zotero → 设置 → 高级 → 杂项**，勾选 **「允许此计算机上的其他应用程序与 Zotero 通讯」**（Allow other applications on this computer to communicate with Zotero），然后重启 Zotero。上传功能不受此开关影响。

读取永远**只读**：不发写请求、不申请写授权 key、不改动任何条目。

## 两个正交的配置维度

**来源 source —— 文件从哪来**

| 值 | 含义 |
|---|---|
| `session`（默认） | 只传**本会话写出或交付**的文件（由 `write`/`edit` 工具结果与 `present` 声明推得）。绝不静默上传对话没碰过的文件 |
| `workspace` | 扫描会话工作目录（限深 3、最多 20 个，自动跳过 `node_modules`、`dist`、`.git` 等） |

**范围 scope —— 哪些文件类型**

| 值 | 含义 |
|---|---|
| `md` | 只要 Markdown（`.md` / `.markdown`） |
| `docs`（默认） | Markdown + txt + PDF + Office + 网页/电子书 |
| `all` | 不限类型，**仅对 session 来源生效**（避免工作区扫描拖进无关二进制） |

## 去重

按**文件内容 sha1** 记一笔上传历史。内容没变的文件再次 sync 会报告"已在 Zotero（位置 C1，《标题》）"而不会建重复条目；`--force` 可强推。历史记录在 `plugin-data/dsh-zotero-sync/history.json`，删掉即"失忆"。

## 安装

### 方式一：命令行安装（推荐）

```bash
# 源码安装，无需 npm 包
dsh plugin --profile web add github:520limited/dsh-zotero-sync
```

### 方式二：从 DSH 内置插件市场（Discover）

在 DSH 设置 → 插件 → 索引源（indexes）里添加本仓库的索引地址：

```
https://raw.githubusercontent.com/520limited/dsh-zotero-sync/main/market/index.json
```

之后在 Discover 页搜索 "zotero" 即可一键安装。

### 方式三：本地目录（开发调试）

```bash
git clone https://github.com/520limited/dsh-zotero-sync
# 然后在 DSH 插件管理器里安装该目录
```

安装后**重启一次 DSH**（桌面端打包运行，插件的 Client 半边需要随页面重新加载）。

## 配置（可选）

默认值写在 bundle 的 `cordis.patch.yml`，你可以在 profile 的补丁层覆盖；运行时用界面/指令做的选择优先级更高：

```yaml
- id: zotero-sync
  name: dsh-zotero-sync
  config:
    baseUrl: http://127.0.0.1:23119
    scope: docs          # md | docs | all
    source: session      # session | workspace
    target: ''           # 留空 = 跟随 Zotero 当前选中的位置
    tags: ['DSH对话笔记']
    workspaceLimit: 20
    workspaceDepth: 3
    maxFileBytes: 83886080
```

层叠优先级：调用参数 > 运行时存储（`settings.json`）> patch config > 内置默认。

## 要求

- DSH（DeepSeek Harness）桌面版 / Web 版，`engines.dsh: >=0.2.0-0`
- Zotero 桌面端运行中
- Node ≥ 18（DSH 自带）

## 权限与风险说明

透明起见，装上这个插件后会发生什么、以及它不做什么：

| 项 | 说明 |
|---|---|
| 网络访问 | 仅访问 `http://127.0.0.1:23119`（本机回环），可在配置中改 `baseUrl`。**不向任何外部服务器发送数据** |
| 文件读取 | 上传：只读你点「上传」时被选中的文件，`source: session`（默认）下仅限本会话写出/交付过的文件。读文库：只经 Zotero API 取元数据与全文，不碰 `zotero.sqlite` |
| 文件写入 | 不写 Zotero 数据库。上传历史写在 `plugin-data/dsh-zotero-sync/history.json`（sha1 + 元数据，不含正文） |
| Zotero 侧 | 上传：每个文件新建一个 `document` 条目 + 附件。**协议无删除端点，插件不能撤销已上传条目**，需要你在 Zotero 里手动删。读文库：**严格只读**，不发送任何写请求，也不申请写授权 |
| 静默行为 | 无。挂载时零请求，不做后台轮询、不自动上传、不自动读取 |
| 账号 | 不需要 Zotero 账号或 API Key，也不读取你的任何凭据 |

已知限制：Zotero 必须正在运行；Connector 会话约 10 分钟过期；上传是「新增」语义，不做文库内去重（只对本地已传过的内容去重）；读文库需一次性开启 Zotero 的本地 API 开关（见上文），PDF 全文依赖 Zotero 的全文索引（未索引的附件拿不到文本）。

## 开发者：协议要点（踩坑记录）

以下每一条都来自 Zotero 10.0.6 源码核对 + 真实 500 错误复盘，改动 `zotero.mjs` 前请读：

1. 必须带 `X-Zotero-Connector-API-Version: 3` 且 UA **非**浏览器形状，否则请求被静默拒绝。
2. `/connector/saveItems` 的 payload **不能带 `proxy: {}`**——空对象也会让 Zotero 构造 `new Zotero.Proxy({})` 而返回裸 500。
3. 附件走 `/connector/saveAttachment` 原始流：Content-Type 不能是纯文本类型（`text/plain` 会被 Zotero 缓冲成字符串、破坏流式写入），所以 `.txt` 改标 `application/octet-stream`；`.md` 保留 `text/markdown` 以便 Zotero 内预览。
4. `X-Metadata` 头按 latin-1 传输，非 ASCII 一律 `\uXXXX` 转义，中文标题才能无损往返。
5. `updateSession` 对 `target` 无空值保护，任何调用都必须带显式 target。
6. Connector 保存会话约 10 分钟过期（`SESSION_NOT_FOUND` → 提示重试即可）。

Local API（读取文库，`library.mjs`）同样有坑，改前先读 `server_localAPI.js`：

7. 每个请求必须带 `Zotero-API-Version: 3`，其他版本一律 501（仅 `/api/` 根豁免）；userID 必须 `0`。
8. 整个 API 在 pref `extensions.zotero.httpServer.localAPI.enabled` 之后，**默认 false**——关着时 `/api/*` 一律 403 "Local API is not enabled"。
9. GET 免鉴权；写请求需要 `/api/local/authorize` 发的 key——本插件只发 GET，永远不碰。
10. `/items/:key/file` 是 302 重定向；`/items/:key/file/view/url` 才是 200 明文返回本地路径，插件用后者。
11. `/items/:key/fulltext` 只对有全文缓存的附件（PDF 等）有效，否则 404；正文来自 Zotero 的全文索引。
12. 列表响应的分页真相在 `Total-Results` 响应头，不在 body。

### 代码结构

```
index.js        Host 半边：zotero_sync + zotero_library 工具 + /zotero 指令 + 会话产出账本
client.js       Client 半边：回合卡片 + 输入框胶囊（只发 /zotero sync，挂载时零请求）
zotero.mjs      Zotero Connector 协议客户端（纯 Node，可独立复用）
library.mjs     Zotero Local API 只读客户端（搜索/详情/全文/附件路径/分类/标签）
operations.mjs  文件发现 + 上传编排（source × scope 矩阵、去重）
settings.mjs    配置层叠与持久化
history.mjs     内容哈希上传记录
test/           5 个离线套件 + 1 个显式开关的 live 套件
```

### 测试

```bash
node test/protocol.test.mjs     # 协议形状（桩 fetch，绝不连真 Zotero）
node test/behaviour.test.mjs    # source×scope 矩阵、配置层叠、工具/指令行为
node test/package.test.mjs      # 包结构、locale 一致、"挂载零请求"防回归断言
node test/deliverables.test.mjs # 会话产出账本 → candidates 全链路（离线）
node test/library.test.mjs      # Local API 只读客户端（桩 /api/users/0）

# 会向你的真实 Zotero 文库创建条目，默认跳过：
ZTS_LIVE=1 node test/live-sync.test.mjs
```

## License

MIT

---

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/zh/plugins/520limited/dsh-zotero-sync)
