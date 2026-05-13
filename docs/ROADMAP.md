# markio · 后续功能与路线图

> 本文按"价值密度 × 工程量"排序，每条都标注当前状态、计划做到哪、技术路线。
> 已落地的能力见 [README](../README.md) 与 [ARCHITECTURE](./ARCHITECTURE.md)。
> 日期格式 `YYYY-MM-DD`，时区 Asia/Shanghai。

---

## 0 · 现状速览

| 模块 | 状态 |
| --- | --- |
| 编辑 / 预览 / WYSIWYG / 阅读四模式 | ✅ |
| 文件树 + 最近 + 附件 + 回收站 | ✅ |
| 历史快照（每文件最多 30 份） | ✅ |
| 原子写 + mtime/hash 冲突检测 | ✅ |
| 全局 Rust grep + 命令面板 | ✅ |
| AI 工作区（10 模式 + 多 provider + 任务侧栏 + 引用预览） | ✅ |
| **本地知识库**：sqlite-vec + Ollama/OpenAI + 混合检索 + 引用图谱 | ✅ |
| 笔记图片：粘贴 / 拖拽 / 本地 Assets / PicGo 上传 / 渲染期 asset:// 重写 | ✅ |
| 源 ↔ 预览双向滚动同步 | ✅ |
| 导出 PDF / HTML / 微信公众号样式复制 | ✅ |
| OS Keychain 存 API Key（AI + 嵌入两套） | ✅ |
| macOS / Windows / Linux Tauri 打包脚本 | ✅ |

下面列的是**已知缺口**与**预期演进**。

---

## 1 · AI / 知识库

### 1.1 流式 AI 响应（高优）

- **现状**：`ai::chat` 是阻塞 reqwest，整段拿到再 return；UI 一次性显示
- **目标**：边出边显，体验和官方客户端一致
- **路线**：
  1. Rust 侧把 `chat` 拆成 `chat_stream`，开 SSE / NDJSON 读取
  2. 用 Tauri `Emitter` 向前端 `emit("ai-chunk", { sessionId, delta })`
  3. 前端 `AIPanel.send()` 改成订阅 channel，逐 token 追加到 message.text
- **影响面**：`ai.rs`、`lib.rs`（新增 `ai_chat_stream` 与 `ai_chat_cancel`）、`AIPanel.tsx`
- **难点**：取消 / 失败回退 / token 计数；Anthropic / OpenAI / Gemini 的流式协议各家不同

### 1.2 RAG Reranker（中优）

- **现状**：混合检索仅靠向量 + BM25 + RRF 融合，对长 query 精度有限
- **目标**：top-20 → reranker → top-K，精度提升 10–20pp
- **路线**：
  - 本地：复用 Ollama 跑 `bge-reranker-v2-m3`（pull 后通过 `/api/generate` 或 cross-encoder API）
  - 云端：Voyage / Cohere rerank（用户在设置切换）
  - 后端：`rag/search.rs` 在融合后增加 rerank 步骤，并加 `rerankProvider` 配置
- **设置项**：`本地知识库` 面板新增「启用 Reranker」+ provider 选择

### 1.3 真实文件监听 → 实时增量索引（中优）

- **现状**：增量索引靠保存钩子 + 删除回调；外部程序改文件不会自动重建
- **目标**：第三方编辑器 / git pull / 拖拽改文件后，索引自动刷新
- **路线**：
  - Rust 引入 `notify` crate，每个已注册仓库一个 watcher
  - 事件 debounce 500 ms → 走 `rag::reindex_file` / `remove_file`
  - 同时刷新前端 fileTree
- **风险**：macOS FSEvents 在 Sandbox 内行为差异；要测试 iCloud 目录

### 1.4 索引面板可视化（中优）

- **现状**：设置里只有进度条 + 文档数
- **目标**：用图谱 / Treemap 展示哪些目录命中频次高、哪些文档孤立
- **路线**：前端用 Cytoscape（已在依赖里）展示链接图；点击节点跳笔记

### 1.5 RAG 评估集（低优 / 工程）

- 内置一组「问题 → 期望命中文档」的 JSON fixture，提供 CLI 跑 recall@K / MRR
- 给后续替换 embedding 模型 / 改分块策略时有参考

---

## 2 · 同步 / 多端

### 2.1 Git 同步（高优）

- **现状**：设置里有「同步」面板（WebDAV / iCloud / 自定义）但都是 UI 壳
- **目标**：Git 优先，因为 markdown 仓库天然 fit
- **路线**：
  - Rust 引入 `git2` 或 `gix`（gitoxide，纯 Rust，沙盒友好）
  - 命令：`git_status` / `git_pull` / `git_commit` / `git_push`
  - 设置：远端 URL + auth（SSH key 走 Keychain / PAT 走 Keychain）
  - 冲突策略：复用现有 `syncConflictStrategy`（ask / newest / local / remote）
  - StatusBar 显示 「未推送 N · 未拉取 M」
- **App Store**：纯 Rust gix 不依赖 libgit2 二进制，沙盒下用 HTTPS + PAT 流程最稳

### 2.2 WebDAV / iCloud 同步（中优）

- WebDAV：reqwest + propfind / put / delete；坚果云、TeraCloud 兼容
- iCloud：直接读 `~/Library/Mobile Documents/com~apple~CloudDocs/`，用 NSMetadataQuery 监听同步状态
- 跨设备冲突需要走 mtime + hash 的现有签名机制

### 2.3 iOS / Android（低优 / 大）

- Tauri 2 已支持 mobile entry，但需要重写 TitleBar / 文件选择 / Keychain 部分
- 优先级低于桌面端打磨；建议等 1.0 后再启动
- 预计要 3–4 周

---

## 3 · 编辑器深化

### 3.1 真协作（CRDT）（低优 / 实验）

- 当前 `showLiveCursors` 是演示效果
- 真协作需要 Yjs 或 Automerge 作 CRDT 文档；Tauri 端跑 y-websocket 不现实，更适合走 cloudflare durable object
- 建议作为「跨设备同一仓库」的补充，先把 Git 同步做扎实再看

### 3.2 表格编辑器（中优）

- 现在表格只能手敲 markdown
- 目标：选中表格区域时浮出表格工具栏（增删行列 / 对齐 / CSV 粘贴）
- 实现：CodeMirror 6 plugin，识别 GFM 表格 block，浮出 widget

### 3.3 数学公式 / 化学式输入辅助（低优）

- KaTeX 渲染已通
- 目标：`$` 自动配对 / `\frac{|}{}` 占位补全 / 公式预览悬浮
- 与现有 Bubble Menu 复用 UI

### 3.4 Outline 双向同步（中优）

- 当前大纲只读
- 目标：拖拽大纲项重排原文（heading 段落跟着移）
- 实现：CM 文档操作 + 大纲组件 dnd-kit

---

## 4 · 图片管线

### 4.1 上传前压缩（中优）

- 设置已有「上传前压缩」+ 质量滑块，但 Rust 侧未接
- 实现：Rust 引入 `image` crate，PNG → 走 `oxipng`、JPEG → `mozjpeg`，按设置质量执行
- 流程：粘贴 → 压缩 → 写 Assets → 可选 PicGo

### 4.2 OSS / S3 / 七牛等内置上传器（低优）

- 现在只有 PicGo（用户跑本地服务）这一条路径
- 目标：设置里挂常见 OSS（阿里 / 腾讯 / 七牛 / S3 兼容）的原生上传
- 风险：密钥要走 Keychain，UI 流程要做好

### 4.3 拖拽到任意位置插入图片（已部分）

- 当前只支持粘贴；拖拽走的是 Tauri 文件拖入流程，需要补：
  - 编辑器内 onDrop → 走 image_paste 相同管线
  - 多文件批量

---

## 5 · 导出 / 第三方集成

### 5.1 微信公众号导出（高优 · 已有壳）

- 现状：`WeChatSheet` 已有 4 套样式预览 + 一键复制 HTML
- 缺：
  - **图片自动上传**：公众号不接受外链图片，需要走素材接口或要求用户先上传
  - **代码块样式**：公众号不支持 `<code>` 自定义类，需要内联 style 化
- 风险：公众号官方 API 需要绑定 appid，自动上传需要 OAuth，暂建议保留「手动复制 + 提示」

### 5.2 腾讯龙虾（低优 / 待定位）

- 当前是 UI 壳，没有任何实际逻辑
- 建议**移除或重新定位**，避免给用户错觉。如要做"AI 起标题/摘要/封面"，重命名为「AI 辅助发布」更合适

### 5.3 导入：Notion / Bear / Obsidian / 印象笔记（中优）

- 当前是按钮 + 图标，未实现
- 路线：每家用各自导出格式
  - Notion：导出 zip → unzip + 解析 markdown + 重写 wiki link
  - Bear：导出 bear-archive，提取 .md
  - Obsidian：基本是 markdown 仓库，主要是把 `[[]]` 链接保留
  - 印象笔记：.enex XML → markdown
- 实现在 Rust 端的 `import.rs`，前端只是 file picker + 进度

### 5.4 导出 EPUB / DOCX（低优）

- 目前只支持 PDF / HTML
- DOCX 走 `pandoc`（用户系统装好）调用；EPUB 也是 pandoc

---

## 6 · 性能 / 大仓库

### 6.1 Rust 全文搜索索引（中优）

- 当前 `fs_grep` 每次都遍历仓库；> 1 万文档时慢
- 目标：复用现有 FTS5 表（已经为 RAG 建好），把 `fs_grep` 改成 FTS5 查询
- 工程：`fs_grep` 优先查 `chunks_fts`，找不到再回退暴力扫；UI 不变

### 6.2 文件树虚拟列表（中优）

- 当前一次性渲染整棵树；> 5000 节点 React 卡顿
- 目标：用 `@tanstack/react-virtual` 把可见区外的 row 折叠
- 注意保留展开 / 折叠状态

### 6.3 流式 markdown 渲染（低优）

- 当前 `md_render` 是一次性返回完整 HTML；> 10 万字会有 100–200ms 卡顿
- 目标：把 HTML 按段落 chunk 返回，前端逐段 append（仅 split 视图收益明显）

### 6.4 文档内查找走 Rust（中优）

- 当前 React walkNodes 实现，> 10 万字卡
- 目标：Rust `fs_find_in_text(text, pattern)` 返回 ranges 列表
- 前端只接收 ranges 做高亮

---

## 7 · 平台与上架

### 7.1 Mac App Store 上架（高优）

- 脚本就绪（见 `scripts/build-mas.sh`、`docs/PACKAGING.md`）
- 待办：
  - Apple Developer 账户 + 签名 / 公证（用户操作）
  - 隐私清单：声明用到了 Keychain、网络客户端、用户选定文件
  - "AI 调用第三方 API 出网"在审核说明里写清楚
- 风险：审核人员可能要求"提供测试账号"，AI 部分可以提供 Ollama 离线测试路径

### 7.2 Windows MSIX（中优）

- 当前 MSI 脚本已就绪
- Microsoft Store 上架要 MSIX；用 `tauri-bundler` 的 msix target
- 签名走 Azure Code Signing

### 7.3 应用更新（高优）

- 目前打出 dmg / msi 后没有自更新通道
- 路线：Tauri 2 `updater` plugin + 自托管 manifest（GitHub Releases 拉 latest.json）
- 设置里加「自动检查更新」开关 + 当前版本号

### 7.4 崩溃 / 错误上报（低优 / 可选）

- Rust 端 panic + 前端 ErrorBoundary 落本地日志（`~/Library/Logs/markio/`）
- 用户可在设置导出最近一次崩溃日志，**不主动上传**（隐私优先）

---

## 8 · 工程基础设施

- **CI**：GitHub Actions 跑 `cargo check` / `tsc -b` / `vite build`；目前没接
- **单元测试**：Rust 端 `markdown.rs` / `rag/chunk.rs` / `rag/graph.rs` 几个纯函数最值得加
- **集成测试**：录一个仓库 fixture，跑「索引 → 检索 → 命中预期」
- **快照测试**：UI 组件用 Playwright 跑 visual diff
- **多语言**：当前 UI 是中文，i18n 用 i18next；中英双语优先

---

## 9 · 优先级建议（按月规划，可视为 1.0 → 1.x）

| 月份 | 重点 |
| --- | --- |
| **2026-06** | 流式 AI + Git 同步 + 应用更新通道 + Mac App Store 提交 |
| **2026-07** | RAG Reranker + 文件监听增量 + 表格编辑器 + 导入 Notion/Obsidian |
| **2026-08** | Windows MSIX + 性能（FTS5 接入 fs_grep + 文件树虚拟列表）+ i18n |
| **2026-09** | EPUB/DOCX 导出 + 索引可视化 + Outline 双向同步 |
| **2026-Q4** | iOS / Android 启动 + 真协作 PoC |

---

## 10 · 想做但暂不计划的

- **公众号自动上传图片**（绑定 appid 风险高，先保持手动）
- **完整 CRDT 协作**（团队产品方向，先把单机做扎实）
- **GUI 插件市场**（社区规模不到，暂用 CSS 主题包替代）
- **AI Agent / 自动操作笔记仓库**（提示工程未稳定，先稳化 RAG）

---

## 反馈

发现疏漏或想抢做某条，开 issue 或 PR 即可；本路线图随版本演进每季度更新一次。
