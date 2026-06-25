# markio

> 一款本地优先的 Markdown 阅读 & 写作器。
> macOS · Windows · Linux 桌面端，基于 Tauri 2 + React 19 + CodeMirror 6 + Rust。

![icon](public/brand/icon-light-256.png)

## 下载

- **Mac App Store**：<https://apps.apple.com/cn/app/markio/id6768647792>（macOS 沙盒版，已上架）
- **直发版（全平台）**：[GitHub Releases](https://github.com/chenqi92/Markio/releases) — macOS（Apple Silicon / Intel）· Windows MSI/NSIS · Linux AppImage/deb，由 GitHub Actions 自动出包

> **两个渠道的 AI 策略不同**：App Store 版本受商店合规约束，在中国大陆 storefront 下只展示本地模型与国内模型源（`auto` 策略）；**直发版完全开放，展示全部 AI 模型源**（`global` 策略，与地区无关）。机制详见 [docs/CHINA_APP_STORE_AI.md](docs/CHINA_APP_STORE_AI.md)。

## 看点

- **本地优先**：所有数据是磁盘上你能直接打开的 .md，没有数据库锁定
- **三种模式**：纯源码 / 分屏 / 阅读 / 真 WYSIWYG（光标离开本行后 markdown 标记自动隐藏）
- **8 套主题** Light · Dark · Solarized · Nord · Sepia · 高对比 · Dracula · Rose
- **AI 助手** 接 Anthropic / OpenAI / Google Gemini / DeepSeek / 本地 Ollama / 自定义 OpenAI 兼容端点
- **Rust 重活儿**：markdown 渲染（pulldown-cmark + syntect）、文件树扫描、grep、HTML 清洗、原子保存、文件签名冲突检测、API Key 写 OS 钥匙串
- **真实可用**：原子写 + fsync + rename，外部修改检测，soft-delete 回收站，历史快照
- 支持 ⌘K 命令面板、⌘⇧F 全文搜索、⌘P 快速打开、⌘F 文档内查找、⌘N 新建（不覆盖）、⌘E 导出 PDF…

## 截图

> 待补；可以在 `pnpm tauri:dev` 启动后自截。

## 功能矩阵

状态含义：✅ 正式可用；🟡 可用但仍需加固；🧪 实验 / 工具；❌ 未做。

| 类目 | 功能 | 状态 |
| --- | --- | --- |
| **阅读** | markdown-it 级别的 GFM、表格、任务列表、脚注、删除线、智能引号 | ✅ |
| | KaTeX 行内 / 块级公式 | ✅ |
| | Mermaid 流程图（懒渲染 + 主题感知） | ✅ |
| | 代码高亮（syntect，140+ 语言） | ✅ |
| | 反向链接 `[[…]]` 扫描 | ✅ |
| **编辑** | CodeMirror 6 源码模式 | ✅ |
| | 真 WYSIWYG（Decoration 隐藏 markdown 标记） | ✅ |
| | 分屏并排 + 同步滚动 | ✅ |
| | 工具栏格式行 / 浮动气泡 / 斜杠菜单 | ✅ |
| | 自动补全 `[[` `@` `#` `:` | ✅ |
| **文件** | 多仓库切换 | ✅ |
| | 文件树 + 右键菜单（重命名 / 在 Finder 显示 / 复制路径 / 改图标 / 回收站） | 🟡 |
| | 拖文件 / 文件夹到窗口直接打开 | ✅ |
| | 历史快照（每次保存写 `.markio/history/`） | ✅ |
| | 回收站（软删 + 恢复 + 永久删除） | ✅ |
| | 原子写 + 外部修改冲突检测 | ✅ |
| **搜索** | ⌘K 命令面板 + 文件名快查（客户端） | 🟡 |
| | ⌘⇧F 全文搜索（Rust grep / FTS fallback，点击命中定位到行） | 🟡 |
| | ⌘F 文档内查找 + 高亮 + 上下翻 + 大小写 / 整词 / 正则 | 🟢 |
| **导出** | PDF（系统打印对话框） | ✅ |
| | HTML 单文件 | ✅ |
| | 复制为 HTML / Markdown 片段 | ✅ |
| | 微信公众号样式预览 + 复制 | 🟡 |
| **AI** | Anthropic / OpenAI / Gemini / DeepSeek / Ollama / 自定义 | ✅ |
| | 流式响应 + 取消生成 | ✅ |
| | API Key 进 OS 钥匙串（不进 Tauri Store / localStorage） | ✅ |
| | 把当前笔记前 6000 字作 system prompt | ✅ |
| **本地知识库** | sqlite-vec 向量索引（每仓库一份 `.markio/rag.db`） | 🟡 |
| | 嵌入模型：本地 Ollama / OpenAI 兼容（用户在设置里切换） | ✅ |
| | 混合检索：向量 + FTS5 关键词 + 引用图谱 → RRF 融合 | ✅ |
| | 保存笔记后自动增量更新；删除 / 移入回收站自动清理 | 🟡 |
| **同步 / 云存储** | Git init / clone / status / fetch / commit / pull / push | 🟡 |
| | WebDAV / S3 / Dropbox / Google Drive 双向同步（三方 diff + manifest 基线 + 自动调度） | 🟡 |
| | P2P 局域网 / 移动端配对同步（mDNS 发现 + WebSocket /sync） | 🟡 |
| **导入** | Notion / Obsidian / Bear / Evernote / Apple Notes | 🟡 |
| | Roam Markdown ZIP / Logseq graph 目录 | 🟡 |
| **扩展 / 集成** | RSS 订阅阅读器 | 🟡 |
| | 网页剪藏（Web Clipper） | 🟡 |
| | PicGo 图床上传 | 🟡 |
| | MCP server（把仓库检索暴露给外部 AI 客户端） | 🟡 |
| | 自定义 CSS 主题导入 | 🟡 |
| | 微信公众号助手 / 智能通道 | 🟡 |
| **平台** | macOS（已上架 Mac App Store，另有直发 dmg） | ✅ |
| | Windows MSI / NSIS | ✅（GitHub Actions 自动出包） |
| | Linux AppImage / deb | ✅（GitHub Actions 自动出包） |
| | iOS / Android | 未做，Tauri 2 支持 |

## 快捷键

| 键 | 行为 |
| --- | --- |
| ⌘K | 命令面板（含最近文件） |
| ⌘P | 同 ⌘K |
| ⌘⇧F | 全文搜索 |
| ⌘F | 当前文档查找 + 高亮（支持大小写 / 整词 / 正则） |
| ⌘S | 保存（带外部修改检测） |
| ⌘N | 新建笔记（不覆盖已有） |
| ⌘⇧D | 打开今日日记（无则按模板新建） |
| ⌘O | 打开单个 .md |
| ⌘⇧O | 打开文件夹（注册为新仓库） |
| ⌘W | 关闭标签（脏 tab 会确认） |
| ⌘. | 专注模式 |
| ⌘⇧L | 侧栏开关 |
| ⌘⇧R | 大纲开关 |
| ⌘1 / ⌘2 / ⌘3 / ⌘4 | 源码 / 分屏 / WYSIWYG / 阅读 |
| ⌘J | AI 助手 |
| ⌘Y | 历史版本 |
| ⌘E | 导出 PDF |
| ⌘, | 设置 |
| `/` | 斜杠插入菜单（行首） |
| `[[` `@` `#` `:` | 弹自动补全 |

## 开发

需要：

- Node 20+ 与 pnpm 9+
- Rust 1.77+，`rustup target add aarch64-apple-darwin x86_64-apple-darwin`（macOS）
- macOS 14+ / Windows 10+

```bash
pnpm install
pnpm tauri:dev              # 开发模式，HMR
pnpm tauri:build            # 发行构建（dmg / msi / appimage）
```

第一次构建 Rust 端会花 ~5 分钟（拉 pulldown-cmark / syntect / reqwest 等），后续增量是几秒。

## 图标

源图：仓库根目录的 `md-view-light.png` / `md-view-dark.png`（1254×1254）。

- `scripts/make-icons.py` 把源图渲染成 macOS 用的"squircle padded"（22.37% 圆角 + 100px 透明边距）与通用全版图标
- 然后 `pnpm tauri icon assets/icon-mac.png` 会把 32×32 → 1024×1024、`.icns`、`.ico`、iOS、Android 全套图标一次性生成到 `src-tauri/icons/`
- 应用内（标题栏 / 欢迎页）的品牌图标在 `public/brand/icon-{light,dark}-{256,512,1024}.png`

要重新生成：

```bash
python3 scripts/make-icons.py
./node_modules/.bin/tauri icon assets/icon-mac.png
```

**根目录的两张源图只是回归资产**，不会被打进发行包；只要 `src-tauri/icons/` 里已经有上次跑出的全套，平时可以把它们挪走。建议放仓库里方便未来重生成。

## 打包 & 上架

详细流程见 [docs/PACKAGING.md](docs/PACKAGING.md)：

- **Mac App Store**：`scripts/build-mas.sh`（沙盒签名 → productbuild → Transporter 上传）。走默认 `auto` AI 策略，中国大陆 storefront 自动收敛模型源，满足商店合规。
- **直发渠道（GitHub Releases）**：`.github/workflows/release.yml` 在 `package.json` 版本号变化时自动构建 macOS / Windows / Linux 四个产物并发版。该 workflow 注入 `VITE_MARKIO_AI_REGION=global`，**所有平台、所有地区都展示完整 AI 模型源**；本地手动直发签名用 `scripts/notarize.sh`（Developer ID → notarytool → stapler）。
- 本地手动出包：`pnpm tauri build`（默认 `auto`）、`pnpm tauri:build:cn`（中国大陆专用包）；直发包想完全开放可加 `VITE_MARKIO_AI_REGION=global`。

AI 地区策略（`auto` / `cn` / `global`）的完整说明见 [docs/CHINA_APP_STORE_AI.md](docs/CHINA_APP_STORE_AI.md)。

## 项目结构

```
md-view/
├── src/                  # 前端 (React 19 + TS)
│   ├── App.tsx           # 全局快捷键 / drag-drop / 启动 hydrate
│   ├── components/       # 所有 UI 组件
│   │   ├── layout/       # AppShell / TitleBar / Sidebar / TabStrip / Toolbar / ...
│   │   ├── editor/       # SourceEditor (CM6) + WYSIWYG decoration + EditorArea
│   │   ├── preview/      # Preview (Rust 渲染结果挂载 + Find 高亮 + Mermaid)
│   │   ├── popovers/     # CommandPalette / FindBar / GlobalSearch / BubbleMenu / SlashMenu / Autocomplete / IconPicker / HistorySheet / AIPanel / WeChatSheet / Toast / ContextMenu
│   │   ├── settings/     # 16 个设置区（外观 / 通用 / 编辑 / 快捷键 / AI / 导出 / 同步 / PicGo / 剪藏 / RSS / 移动端 / 微信 / 公众号助手 / 智能通道 / MCP / 关于）
│   │   └── ui/           # Icon / Toggle / Slider / SelectBtn
│   ├── stores/           # zustand
│   │   ├── workspace.ts  # 多仓库 + 树缓存 + Rust 注册
│   │   ├── tabs.ts       # 打开 tab + 脏标 + 签名表
│   │   ├── ui.ts         # 侧栏 / 大纲 / 模式 / 各种 popover 开关
│   │   ├── settings.ts   # 主题 / 字号 / AI / 自动保存
│   │   ├── streak.ts     # 写作连击
│   │   ├── recents.ts    # 最近文件
│   │   └── fileIcons.ts  # 文件树自定义图标
│   ├── lib/
│   │   ├── api.ts        # Rust 命令 typed wrapper
│   │   ├── editor-bridge.ts  # 跨组件操作 CodeMirror
│   │   ├── wikilinks.ts  # [[link]] / ![[embed]] 预览增强
│   │   ├── mermaid.ts    # 懒加载 mermaid + 主题切换重绘
│   │   ├── export.ts     # PDF / HTML / 剪贴板导出
│   │   └── utils.ts      # debounce / classNames / formatBytes / ...
│   ├── styles/           # themes (8) + layout / sidebar / main / markdown / wysiwyg / popovers / settings
│   ├── themes/index.ts   # 主题元数据
│   └── types/index.ts    # 所有跨边界类型
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs        # Tauri 命令入口 + AppState 管理
│   │   ├── state.rs      # 工作区 allowlist + 文件签名表
│   │   ├── fs_ops.rs     # 文件遍历 / grep / 原子写 / 回收站 / 快照
│   │   ├── markdown.rs   # pulldown-cmark + syntect + ammonia 清洗
│   │   ├── ai.rs         # Anthropic / OpenAI / Gemini / Ollama 代理
│   │   ├── secrets.rs    # keyring wrapper（macOS Keychain / Win Credential / Linux SS）
│   │   └── rag/          # sqlite-vec 向量索引 + 混合检索 + 引用图谱
│   │       ├── db.rs     # 5 张表 + sqlite-vec 扩展加载 + 维度变更迁移
│   │       ├── chunk.rs  # 按 ATX 标题层级 + 段落聚合的 markdown 分块
│   │       ├── embed.rs  # Ollama / OpenAI 兼容 embedding provider
│   │       ├── index.rs  # 全量 / 增量索引 + 进度上报
│   │       ├── search.rs # 向量 + FTS5 + RRF 融合 + 引用图扩展
│   │       └── graph.rs  # [[wiki]] / md 链接提取 + 反查
│   ├── entitlements/     # macOS App Sandbox + 直发 entitlements
│   ├── capabilities/     # Tauri 权限定义
│   └── tauri.conf.json
├── public/brand/         # 应用内品牌图标（亮 / 暗 × 256 / 512 / 1024）
├── assets/               # 打包源图（mac padded + win full-bleed）
├── scripts/              # build-mas.sh / notarize.sh / make-icons.py
└── docs/                 # ARCHITECTURE.md / PACKAGING.md / MARKIO_DESIGN.md（旧设计稿）
```

## 路线图

后续功能与近期规划见 [docs/ROADMAP.md](docs/ROADMAP.md)。简版：先守住 CI / fmt / clippy / 测试门禁，再补数据安全、同步闭环、导入报告、功能入口分层和大模块拆分。

## 数据怎么存

```
~/                                # 用户家目录
└── 你选的笔记仓库/                # 任意已挂进 markio 的目录
    ├── *.md                      # 普通文件，所见即所得
    └── .markio/                  # 仓库私有数据（不入 Git 时记得 .gitignore）
        ├── history/              # 历史快照，每次保存一份，每个文件最多 30
        ├── trash/                # 软删的文件 + 元数据
        └── rag.db                # sqlite-vec 向量索引 + FTS5 关键词索引 + 引用图谱

~/Library/Application Support/markio/   # macOS（Windows 在 %APPDATA%）
└── store.bin                           # Tauri Store：设置、仓库列表、UI 状态等

localStorage                     # 浏览器开发模式 fallback；正式桌面端优先走 Tauri Store
├── markio.settings.v1           # 主题 / 字号 / AI 配置（不含 API Key）
├── markio.workspaces.v1         # 仓库列表
├── markio.ui.v1                 # 侧栏 / 大纲 / 模式
├── markio.recents.v1            # 最近文件
├── markio.streak.v1             # 写作连击
└── markio.fileIcons.v1          # 文件树自定义图标

OS Keychain（com.welape.mdview）  # 真正的密钥
├── ai:anthropic / ai:openai / ai:* （AI 聊天用 key）
└── embed:openai （RAG 嵌入用 key，单独存以便和聊天 key 区分）
```

## 安全模型

详细见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的"安全边界"一节。要点：

1. **HTML 清洗**：Rust `markdown::render()` 输出前过一次 `ammonia`，剥离 `<script>` / `<iframe>` / 事件属性 / `javascript:` URL
2. **CSP**：`tauri.conf.json` 关闭 `unsafe-eval` 与第三方源（AI 请求一律走 Rust 代理）
3. **文件命令 allowlist**：所有 fs / history / trash / reveal 命令都先 canonicalize 路径，校验在已注册仓库内，拒绝外部
4. **原子写**：写入临时文件 → fsync → rename，避免半文件
5. **冲突检测**：保存前对比 mtime，跟前端记录不符就返回 `CONFLICT:<mtime>:<hash>`，前端弹窗让用户决定
6. **创建不覆盖**：新建笔记走 `OpenOptions::create_new(true)`，存在时返回 `ALREADY_EXISTS:<path>`
7. **API Key 入钥匙串**：前端只看 "已配置 / 未配置" 布尔，聊天与嵌入 key 不进 localStorage / store.bin

## 已知 trade-off

- **小仓库的文件名搜索**仍在前端走（命令面板内嵌缓存树）。> 1 万节点的仓库建议改 Rust grep
- **WYSIWYG 边界情况**：嵌套列表、表格内的行内标记现在不会精细装饰，光标在该行时全部显形
- **iOS / Android** 还没接 Tauri 2 mobile entry point；桌面优先
- **同步能力分层**：WebDAV / S3 / Dropbox / Google Drive 已是双向同步引擎（三方 diff + manifest 基线 + 重试 + 自动调度），但仍有已知缺口——跨机器时钟下的 `newest` 冲突判定、长同步期间的 TOCTOU、tombstone 落盘尚未补齐，建议重要数据另留 Git 备份

## License

MIT
