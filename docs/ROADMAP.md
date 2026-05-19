# markio · 长期落地计划

> 更新时间：2026-05-18，时区 Asia/Shanghai。
> 本文只记录真实状态、临时处理、未闭环能力和后续落地顺序。用户可见入口必须和真实能力一致。

---

## 0 · 状态标记

| 标记 | 含义 |
| --- | --- |
| ✅ 正式 | 已实现、已接入主流程，有基础测试或人工验证 |
| 🟡 可用但需加固 | 用户可以使用，但仍有数据安全、错误提示、边界场景或测试缺口 |
| 🧪 实验 / 工具 | 有入口或底层命令，但不是完整产品闭环 |
| ❌ 未做 | 没有可交付实现，不能包装成正式功能 |

---

## 1 · 当前真实状态

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 编辑 / 预览 / WYSIWYG / 阅读 | ✅ 正式 | CodeMirror、markdown 渲染、同步滚动、Mermaid/KaTeX/代码高亮已可用 |
| 文件保存 / 历史 / 回收站 | 🟡 可用但需加固 | 原子写、mtime/hash 冲突检测、历史快照、文件/目录回收站可用；写文件入口需统一审计 |
| 文件树 / 快速打开 / 全文搜索 | 🟡 可用但需加固 | 文件树已有虚拟列表；仍有深度、数量、隐藏文件、只显示 markdown 等硬限制 |
| 文档内查找 | 🟢 基本完成 | 支持大小写、整词、正则、预览高亮和源码定位；长文档计数走 Rust |
| AI 聊天 | ✅ 正式 | 多 provider、流式响应、取消、任务侧栏和引用预览已接入 |
| 本地知识库 RAG | 🟡 可用但需加固 | sqlite-vec + FTS5 + 引用图谱 + RRF 已可用；重建取消已接入，暂停、失败恢复和重试还需补 |
| 文件监听 / 增量索引 | 🟡 可用但需加固 | watcher 已有；需要更细事件类型、错误恢复和外部批量变更后的重建策略 |
| Git 同步 | 🟡 可用但需加固 | git init/clone/status/fetch/commit/pull/push 等命令已接；自动同步已拆为 preflight/snapshot/fetch/pull/push，冲突恢复和回滚仍需加固 |
| WebDAV / S3 / Dropbox / Google Drive | 🧪 实验 / 工具 | 有连接、列表、上传、下载、删除等基础能力；不是统一双向同步引擎 |
| iCloud | 🧪 实验 / 工具 | 主要依赖系统文件夹同步；应用内未掌握云端冲突、同步进度和错误 |
| 导入 Notion / Obsidian / Bear / Evernote / Apple Notes | 🟡 可用但需加固 | 已有导入命令；格式转换、资源路径、进度报告和丢失项报告需要产品化 |
| Roam / Logseq 导入 | 🟡 可用但需加固 | Roam 仅支持 Markdown ZIP，Logseq 复制 pages / journals / assets；JSON / org 转换和完整报告还需补 |
| PDF / HTML / 多格式复制 | ✅ 正式 | 主流程可用 |
| 微信公众号样式复制 | 🟡 可用但需加固 | 预览和复制可用；直接推送草稿、图片素材上传和代码块内联化未闭环 |
| Smart Channel | 🧪 实验 / 工具 | 目前是 `window.__markioSmartChannel` 临时桥；正式化前需改 Tauri command、权限和配额模型 |
| 更新 / i18n / 打包脚本 | ✅ 正式 | Tauri updater、中文/英文资源、桌面打包脚本已存在；仍需发布链路验证 |
| CI / Rust 门禁 | ✅ 正式 | 2026-05-18 已改为源码变更触发 CI，并强制 fmt / clippy |
| 前端 lint / E2E / visual regression | ❌ 未做 | 目前只有 TypeScript build 和 Vitest 单测 |

---

## 2 · 必须清掉的临时处理

1. **Smart Channel 临时全局入口**
   - 现状：浏览器全局对象 + localStorage 配额。
   - 落地标准：Tauri command、显式权限、配置持久化、错误可见。

2. **半闭环同步能力**
   - 现状：Git 有命令和自动同步雏形；云盘服务是工具集，不是同步系统。
   - 落地标准：统一 sync engine、双向 diff、删除语义、冲突策略、重试、审计日志。

3. **后台错误静默降级**
   - 现状：RAG、历史、同步、索引、若干后台任务会吞掉错误或只写 console。
   - 落地标准：状态栏 / toast / 设置页诊断都能看到最近失败原因，并支持重试。

4. **大模块继续膨胀**
   - 现状：`Settings.tsx`、`src-tauri/src/lib.rs`、`AIPanel.tsx` 已经过大。
   - 落地标准：按设置域、Tauri command 域、AI 会话域拆分，新增功能不得继续堆进同一个文件。

5. **用户入口和真实能力不一致**
   - 现状：微信公众号、云同步、导入、Smart Channel 的用户预期容易被 UI 放大。
   - 落地标准：正式功能、实验功能、未实现功能在 UI 和文档里明确分层。

---

## 3 · P0：质量地基

目标：任何源码变更都不能绕过基础质量检查。

已落地：
- CI 不再只监听 `package.json`。
- `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`、前端 build/test 会在 CI 主流程执行。
- 本地 Rust fmt / clippy 已清零。

继续补：
- 增加前端 lint：ESLint + React hooks 规则 + import 边界规则。
- 增加最小 E2E：启动、打开文件夹、打开文件、编辑保存、冲突提示、搜索、导入报告。
- 增加发布前 checklist：build、测试、updater manifest、签名/公证、回滚包。

---

## 4 · P1：数据安全闭环

目标：任何写入、删除、同步都不能让用户在不知情时丢数据。

任务：
- 统一文件写入 API，所有保存路径必须经过 expected mtime/hash 或明确 force。
- 清理旧兼容写入入口，避免绕过冲突检测。
- 实现目录回收站：目录 move、manifest、restore、purge 全链路。
- Git 自动同步已拆出 preflight → snapshot → fetch → pull → push → result；继续补 commit preview、冲突恢复和回滚。
- `syncConflictStrategy` 真正接入 Git 和云同步，不再只是设置项。
- 后台任务失败统一进入诊断中心。

验收：
- 外部编辑同一文件时，保存不会静默覆盖。
- 删除目录可以恢复。
- Git pull 冲突时不会自动覆盖本地工作区。

---

## 5 · P2：正式功能和实验功能分层

目标：用户看到的每个入口都准确表达真实能力。

任务：
- 微信公众号：要么补完素材上传 + draft push，要么重命名为“公众号排版复制”。
- WebDAV / S3 / Dropbox / Google Drive：先标为“云存储工具”，再规划统一同步引擎。
- Smart Channel：默认隐藏到实验设置；正式化前不作为主功能宣传。
- 导入器：输出转换报告，列出成功、跳过、资源丢失、格式降级。
- Roam / Logseq：未实现前不放正式按钮。

验收：
- 设置页不会让用户误以为已经有完整云同步。
- 每次导入都有可追踪报告。
- 公众号入口不会承诺尚未实现的“直接发布”。

---

## 6 · P3：架构拆分

目标：继续做长期软件时，核心文件不再成为协作和回归风险。

任务：
- 拆 `Settings.tsx`：Appearance、Editor、AI、RAG、Sync、Import、Publish、About。
- 拆 `lib.rs` command：filesystem、markdown、ai、rag、sync、cloud、import、window。
- 拆 `AIPanel.tsx`：session state、stream control、mode picker、message list、citation preview。
- 为 sync/import/rag 建独立领域测试 fixture。

验收：
- 单个 UI 文件原则上不超过 800 行，Rust command 模块不超过 1000 行。
- 新增设置项无需修改一个 5000 行组件。

---

## 7 · P4：性能与体验深化

目标：大仓库和长文档下持续可用。

任务：
- 全文搜索优先复用 FTS5，暴力 grep 只做 fallback。
- 预览查找继续优化超长文档高亮分片，避免一次性 DOM walk 造成抖动。
- RAG 重建已支持取消；继续补暂停、失败恢复、重试。
- 文件树限制可见化：显示截断原因、支持继续加载或全局搜索。
- 替换 `window.alert/confirm/prompt` 为统一 Dialog。

验收：
- 1 万文件仓库不会因树渲染或搜索明显卡顿。
- 10 万字文档查找和预览不会锁 UI。
- 关键错误都有用户可见恢复路径。

---

## 8 · 推荐落地顺序

| 阶段 | 时间 | 目标 |
| --- | --- | --- |
| P0 | 已启动 | CI、fmt、clippy、文档真实状态 |
| P1 | 接下来 3-5 个节点 | 文件写入审计、目录回收站、Git 同步状态机、错误诊断 |
| P2 | 之后 1-2 周 | 功能入口分层、导入报告、微信公众号定位、云存储定位 |
| P3 | 之后 2-3 周 | Settings / lib.rs / AIPanel 拆分和测试 fixture |
| P4 | 持续 | 大仓库搜索、长文档查找、RAG 任务控制、Dialog 统一 |
