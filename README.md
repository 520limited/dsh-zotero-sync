# dsh-zotero-sync

> DeepSeek Harness 插件：把 **AI 对话中产出的文档**（Markdown 笔记、PDF、Office 文件）一键上传到本机 **Zotero** 桌面端文库。
>
> A DeepSeek Harness plugin that syncs documents produced in your AI conversations into your local Zotero library — no account, no API key, nothing to install inside Zotero.

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
```

### Agent 工具 `zotero_sync`

`action` 取值：`status` · `targets` · `candidates`（预览将上传的文件）· `sync` · `configure`。
Agent 侧同样受配置约束，不会越权上传你没见过的文件。

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

### 方式一：从插件商店（Discover）

在 DSH 设置 → 插件 → 索引源（indexes）里添加本仓库的索引地址：

```
https://raw.githubusercontent.com/520limited/dsh-zotero-sync/main/market/index.json
```

之后在 Discover 页搜索 "zotero" 即可一键安装。

### 方式二：npm（发布后）

```
在插件管理器输入包名 dsh-zotero-sync 安装
```

### 方式三：本地目录

```bash
# 把仓库 clone 到任意目录后，在 DSH 插件管理器里安装该目录
git clone https://github.com/<你的用户名>/dsh-zotero-sync
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

- DSH（DeepSeek Harness）桌面版 / Web 版
- Zotero 桌面端运行中
- Node ≥ 18（DSH 自带）

## 开发者：协议要点（踩坑记录）

以下每一条都来自 Zotero 10.0.6 源码核对 + 真实 500 错误复盘，改动 `zotero.mjs` 前请读：

1. 必须带 `X-Zotero-Connector-API-Version: 3` 且 UA **非**浏览器形状，否则请求被静默拒绝。
2. `/connector/saveItems` 的 payload **不能带 `proxy: {}`**——空对象也会让 Zotero 构造 `new Zotero.Proxy({})` 而返回裸 500。
3. 附件走 `/connector/saveAttachment` 原始流：Content-Type 不能是纯文本类型（`text/plain` 会被 Zotero 缓冲成字符串、破坏流式写入），所以 `.txt` 改标 `application/octet-stream`；`.md` 保留 `text/markdown` 以便 Zotero 内预览。
4. `X-Metadata` 头按 latin-1 传输，非 ASCII 一律 `\uXXXX` 转义，中文标题才能无损往返。
5. `updateSession` 对 `target` 无空值保护，任何调用都必须带显式 target。
6. Connector 保存会话约 10 分钟过期（`SESSION_NOT_FOUND` → 提示重试即可）。

### 代码结构

```
index.js        Host 半边：zotero_sync 工具 + /zotero 指令 + 会话产出账本
client.js       Client 半边：回合卡片 + 输入框胶囊（只发 /zotero sync，挂载时零请求）
zotero.mjs      Zotero Connector 协议客户端（纯 Node，可独立复用）
operations.mjs  文件发现 + 上传编排（source × scope 矩阵、去重）
settings.mjs    配置层叠与持久化
history.mjs     内容哈希上传记录
test/           4 个离线套件 + 1 个显式开关的 live 套件
```

### 测试

```bash
node test/protocol.test.mjs     # 协议形状（桩 fetch，绝不连真 Zotero）
node test/behaviour.test.mjs    # source×scope 矩阵、配置层叠、工具/指令行为
node test/package.test.mjs      # 包结构、locale 一致、"挂载零请求"防回归断言
node test/deliverables.test.mjs # 会话产出账本 → candidates 全链路（离线）

# 会向你的真实 Zotero 文库创建条目，默认跳过：
ZTS_LIVE=1 node test/live-sync.test.mjs
```

## License

MIT
