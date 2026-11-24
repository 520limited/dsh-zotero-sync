# README 媒体素材

README 第一屏需要一张**真实界面**的动图。其余图示已经就绪。

## 目录内容

| 文件 | 用途 | 状态 |
|---|---|---|
| `architecture.svg` | 数据流图：写入走 Connector、读取走 Local API | ✅ 已完成 |
| `grouping.svg` | 一次同步多个文件时，合并成一个条目 vs 一文件一条目 | ✅ 已完成 |
| `demo.gif` | 第一屏动图：回合尾部卡片点上传 → Zotero 里出现条目 → 附件能打开 | ⬜ 待录 |
| `demo-poster.png` | 动图加载前的静态封面（可选，GIF 首帧即可） | ⬜ 待截 |

## 怎么录 `demo.gif`

目标长度 **15–30 秒**，宽度 **1280**，控制在 **2 MB 以内**（GitHub 对超过 ~5 MB 的动图会懒加载甚至不内联播放）。

推荐流程：

1. 准备一个干净的会话，让 Agent 产出一份 Markdown 笔记（内容里带一级标题，例如 `# Reconstruct Anything Model`，这样条目名会取这个标题——正好展示 v1.3.0 的命名逻辑）。
2. 窗口宽度调到 1280 左右，关掉侧边栏和无关面板，避免泄露私人路径与文件内容。
3. 用 [ScreenToGif](https://www.screentogif.com/)（Windows）或 LICEcap 录这一段：
   - 回合结束，尾部卡片出现 → `上传到 Zotero`
   - 点击 → 行内状态从 `正在上传…` 变成 `已上传`
   - 切到 Zotero，刷新，新条目出现，标题是文档的真标题
   - 展开该条目，看到附件；双击能打开
4. 导出时裁掉多余留白，帧率 10–12 fps 足够（这类界面动作用不高帧率），256 色调色板。
5. 存为 `docs/media/demo.gif`，并在 README 第一屏把占位块换成：

```html
<p align="center">
  <img src="docs/media/demo.gif" width="900" alt="点击上传，文档出现在 Zotero 文库中">
</p>
```

## 截图注意

- 路径、文件名、笔记正文都可能带个人信息，录之前换成 `D:\notes\demo.md` 这类中性内容。
- 不要出现 Zotero 里其他真实文献的标题。
- 中文与 emoji 标题值得保留一点，这正是插件的卖点（无损往返），但不要带上真实姓名。
