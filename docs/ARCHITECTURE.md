# markio · 架构

> 实际跑起来是什么样。
> 跟 `MARKIO_DESIGN.md` 的早期设计稿有出入时，以本文为准。

## 进程模型

```
┌─────────────────────────────────────┐         ┌──────────────────────────┐
│  WebView (WKWebView / WebView2)     │  IPC    │  Rust (单进程)            │
│  React 19 + Zustand + CodeMirror 6  │ ◄────►  │  tauri / pulldown-cmark   │
│  只渲染 UI、管会话状态               │         │  syntect / ammonia        │
│                                     │         │  reqwest / keyring        │
└─────────────────────────────────────┘         └──────────────────────────┘
```

- 前端**不**直接读写文件 / 调网络 AI；所有 IO 走 Tauri command IPC
- Rust 端是单 binary，命令是无状态函数 + 一份 `tauri::State<AppState>`
- 多窗口未启用（首版 single-window）

## Rust 模块

| 模块 | 干啥 |
| --- | --- |
| [`lib.rs`](../src-tauri/src/lib.rs) | 入口；定义全部 `#[tauri::command]`；管 `AppState` |
| [`state.rs`](../src-tauri/src/state.rs) | `AppState` = 已注册的 workspace 集合 + 已打开文件的指纹表；`ensure_in_workspaces()` 闸门 |
| [`fs_ops.rs`](../src-tauri/src/fs_ops.rs) | 递归 walker（带 hard-skip 列表）/ 原子写 / 创建不覆盖 / grep / 反链 / 回收站 / 快照 / Finder reveal |
| [`markdown.rs`](../src-tauri/src/markdown.rs) | pulldown-cmark 渲染 + syntect 高亮 + ammonia 清洗 + 大纲抽取 |
| [`ai.rs`](../src-tauri/src/ai.rs) | reqwest 代理调 Anthropic / OpenAI 兼容 / Google Gemini，支持流式响应与取消 |
| [`secrets.rs`](../src-tauri/src/secrets.rs) | `keyring` 包装：macOS Security framework / Windows Credential Manager / Linux Secret Service |

## 关键命令

| 命令 | 入参 | 出参 | 校验 |
| --- | --- | --- | --- |
| `md_render` | source | `{ html, outline, words, readingMinutes }` | HTML 走 ammonia |
| `workspace_register` | path | canonicalized path | 把 path 加入 allowlist |
| `workspace_unregister` | path | () | 从 allowlist 移除 |
| `fs_read_tree` | path | `FileEntry` 嵌套树 | 必须已注册 |
| `fs_open` | path | `{ content, sig }` | 必须已注册；记录指纹 |
| `fs_close` | path | () | 释放指纹 |
| `fs_save` | path, content, expected_mtime?, force? | `sig` 或 `CONFLICT:..` | allowlist + mtime 比对 |
| `fs_create_new` | path, content | `sig` 或 `ALREADY_EXISTS:..` | `create_new(true)` |
| `fs_rename` / `fs_delete` / `fs_mkdir` | path(s) | () | allowlist |
| `fs_grep` | root, query, max | `Vec<GrepHit>` | allowlist；单文件 ≤ 2 MB；全库 ≤ 3000 文件 |
| `fs_backlinks` | workspace, file | `Vec<Backlink>` | allowlist |
| `fs_trash_move/list/restore/purge` | workspace, ... | varies | allowlist |
| `history_save/list/read` | workspace, file | varies | allowlist；最多保留 30 份/文件 |
| `secret_set/get/has/delete` | account, value? | bool/string/() | 直通 keyring |
| `ai_chat` | `{ provider, endpoint?, model, messages, ... }` | `{ text, model, usage }` | 无 apiKey 时从 keychain 自动拉 |
| `ai_chat_stream` / `ai_chat_cancel` | stream id + chat request | Tauri event chunk/done/error | 流式响应；取消状态在 Rust 端清理 |

## 安全边界

### Layer 1 — markdown 渲染

`markdown.rs::render()` 用 pulldown-cmark 解析后，先组装 HTML，**临走前过一遍 `ammonia::Builder`**：

```rust
b.add_tags(&["span","mark","div","input","section","article","details","summary","figure","figcaption"]);
b.add_generic_attributes(&["class","id","data-lang","data-mermaid","data-line"]);
b.add_tag_attributes("input", &["type","checked","disabled"]);
b.add_tag_attributes("a", &["href","title","target","rel","id"]);
b.add_tag_attributes("img", &["src","alt","title","width","height"]);
```

允许的：常用 markdown 标签 + GFM 任务复选框 + Mermaid 占位 `<div class="mermaid-block" data-mermaid="…">` + syntect 高亮 span 上的 class
**禁止的**：`<script>`、`<iframe>`、`on*` 事件属性、`javascript:` 协议、相对 URL 改写到任意路径

### Layer 2 — CSP

`tauri.conf.json` 的 `security.csp`：

```
default-src 'self' ipc: http://ipc.localhost;
img-src 'self' asset: data: blob: https:;
font-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self' 'wasm-unsafe-eval';
connect-src 'self' ipc: http://ipc.localhost asset:;
frame-src 'none'; object-src 'none'; base-uri 'self'
```

- **没有** `unsafe-eval`、`unsafe-inline` 在 script 上 → 即使 ammonia 漏了一个 inline script 也跑不起来
- AI 请求一律走 `tauri-ipc → reqwest`，所以 `connect-src` 不需要放 api.anthropic.com 等

### Layer 3 — 文件命令 allowlist

`AppState` 维护一个 `HashSet<PathBuf>`，前端 `workspaceRegister(path)` 调用时 push 进去：

```rust
pub fn ensure_in_workspaces(workspaces: &HashSet<PathBuf>, target: &Path)
  -> Result<PathBuf, String> {
    // 优先 canonicalize 自身（已存在的文件）
    // 否则 canonicalize 父目录后拼回 file_name（新建场景）
    // 校验 canon.starts_with(any registered workspace)
}
```

所有 `fs_*`、`history_*`、`fs_trash_*`、`fs_reveal` 命令调用前都进这道闸。**不在已注册仓库的路径直接返回 "拒绝访问"。**

启动时 `App.tsx` 调 `workspace.hydrate()`，把 Tauri Store（浏览器开发模式为 localStorage fallback）里持久化的仓库列表再注册一遍，否则刚启动时所有命令都会被拒。

### Layer 4 — 写入原子化 & 冲突检测

```
fs_save(path, content, expected_mtime?, force?):
  canon = ensure_in_workspaces(path)
  if not force and canon.exists():
    disk_sig = signature(canon)         # FNV-1a 64-bit + mtime
    base = expected_mtime or state.last_sig(canon).mtime
    if disk_sig.mtime > base:
      return Err("CONFLICT:<disk_mtime>:<disk_hash>")
  atomic_write(canon, content):         # tmp = parent/.markio-tmp-<pid>-<ns>
    File::create(tmp).write_all(...).sync_all()
    fs::rename(tmp, canon)
  state.record_open(canon, new_sig)
  Ok(new_sig)
```

前端 `tabs.saveTab(id, force)` 拿到 `"conflict"` 时弹确认框 → 用户选"覆盖"再调一次 `force = true`。

### Layer 5 — API Key

前端 **从不** 拿明文 Key。

- 用户在 设置 → AI 助手 输入 Key → onBlur 触发 `secret_set("ai:<provider>", key)`
- 设置面板只看 `secret_has("ai:<provider>")` 的布尔
- `ai_chat` 命令：前端传 `{ provider, model, ... }`，不传 key；Rust 端如果没收到 key 就 `secrets::get("ai:<provider>")` 自动取

钥匙串底层：

| OS | 后端 |
| --- | --- |
| macOS | Security framework → 用户登录钥匙串 |
| Windows | Credential Manager |
| Linux | Secret Service (gnome-keyring / kwallet) |

## 前端模块

### Zustand stores

- **`workspace`**：仓库列表 + 文件树缓存 + 跟 Rust 同步注册
- **`tabs`**：打开的 tab + 内容（前端的"工作副本"）+ 文件签名表（来自 `fs_open` 的 `sig`）+ 脏标
- **`ui`**：侧栏 / 大纲 / 专注模式 / 4 种 view mode / 各种 popover 开关 / find 查询 / sidebar 宽度
- **`settings`**：theme / fontSize / shortcutStyle / autosave / AI provider / AI endpoint / AI model / **aiKeyConfigured: boolean**（不含明文 Key）
- **`streak`**：写作连击 + 今日字数
- **`recents`**：最近打开（命令面板 / 欢迎页复用）
- **`fileIcons`**：每文件自定义图标

### 数据流（编辑→保存）

```
用户敲键
  → CodeMirror onChange
  → tabs.updateContent(id, content)  (dirty = content !== baseline)
  → Preview 监听 source 变化 → debounce 60ms → api.renderMarkdown(content) → setHtml
  → EditorArea autosave effect → debounce 800ms → tabs.saveTab(id)
  → api.save(path, content, sig.mtime)
  → Rust ensure_in_workspaces → 比 mtime → 原子写 → return new sig
  → tabs.sigs[id] = newSig；baseline = content；dirty = false
  → history_save 异步：写 .markio/history/<key>__<ts>.md
```

### CodeMirror 拓展

- `@codemirror/lang-markdown` 给出 lezer-markdown AST
- 我们包了一层 `wysiwyg.ts`：`ViewPlugin` + `syntaxTree` 遍历，对 `ATXHeading*` / `StrongEmphasis` / `EmphasisMark` / `LinkMark` / `TaskMarker` / `Blockquote` / `HorizontalRule` 等节点装饰
  - 行内 mark：给文本加 class（`.cm-md-bold` / `.cm-md-italic` / …）
  - 行级 line decoration：给整行加 class（`.cm-md-h1` / `.cm-md-quote-line` / …）
  - 隐藏 marker：光标不在该行时用 `Decoration.replace({})` 吃掉 `#` / `**` / `>` / `[ ]`
  - 任务复选框：替换 `[ ]` / `[x]` 为真复选框 widget，点击切换源码

### 性能

- 文件树扫描：递归 + hard-skip 列表（`node_modules` / `target` / `.git` …）+ 上限 8000 文件 / 深度 8
- 全文 grep：单文件 ≤ 2 MB；全库 ≤ 3000 文件；结果限 80 条
- 渲染防抖：60ms；只保留最新 seq，旧请求结果丢弃
- 自动保存防抖：800ms
- Mermaid：懒导入，主题切换时只重绘已渲染节点

## 持久化

- **磁盘**：你打开的 .md 文件，加上仓库根的 `.markio/history/` 与 `.markio/trash/`
- **Tauri Store / localStorage fallback**：见 README "数据怎么存"
- **OS 钥匙串**：API Key

## 跨平台兼容

markio 同时跑 macOS 与 Windows（Linux 作为副产物），所有跨平台敏感点都已统一在 Rust 端做：

| 关注点 | 做法 | 备注 |
| --- | --- | --- |
| **grep 实现** | 纯 Rust（`std::fs` + `str::contains`），不调系统二进制 | macOS / Win / Linux 同一份代码；不依赖 GNU coreutils 或 PowerShell |
| **路径分隔符** | 全用 `PathBuf` / `Path`，避免硬编码 `/` 或 `\\` | `Path::starts_with` 是组件级比对 |
| **canonicalize** | 入注册 / 入校验时都过一次 | Windows 上返回 `\\?\C:\…` UNC 形式，allowlist 双方一致即可 |
| **大小写敏感** | `is_skip_dir`、`is_markdown` 都先 `to_ascii_lowercase` | macOS APFS 默认不敏感、Windows NTFS 默认不敏感、Linux ext4 敏感 — 统一小写后行为一致 |
| **行结束符** | `str::lines()` 同时吃 `\n` 与 `\r\n` | Windows CRLF 不影响行号计算 |
| **隐藏文件判定** | `name.starts_with('.')` | Windows 上 `.git` / `.markio` 等仍按惯例隐藏；NTFS 的 hidden attribute 不参与 |
| **原子写** | temp file + `sync_all` + `fs::rename` | 同卷上 Windows rename 也是原子的；跨卷会失败（IO err） |
| **OS 钥匙串** | `keyring` crate 自动选实现 | macOS Security framework / Win Credential Manager / Linux Secret Service（gnome-keyring / kwallet） |
| **Reveal in OS** | `#[cfg]` 分支三套命令 | macOS `open -R` / Win `explorer /select,` / Linux `xdg-open` |
| **TLS** | `reqwest` + `rustls-tls`（不依赖系统 OpenSSL） | Win 上不用装 OpenSSL；macOS 上不用 Secure Transport 兼容性 |
| **PDF 导出** | 走系统打印对话框（`window.print()` 走 webview） | Win 上是 Microsoft Print to PDF；macOS 上是 Save as PDF |

**没做**（明确的平台限制）：
- macOS 沙盒上架：用 Security-Scoped Bookmark；Win Store 上架：MSIX。当前 dev / 直发版本不受影响
- Win 上 `keyring` 一次 set 后 Credential Manager 里会显示明文 entry name "com.welape.mdview ai:anthropic"。这是 OS 行为，不是泄露

## 知识库定位与 AI 上下文策略

markio 不止是阅读器，目标是"本地 markdown 知识库 + AI"。AI 怎么"读"仓库决定了产品上限：

### 三档定位

| 仓库规模 | 推荐策略 | 实现 |
| --- | --- | --- |
| **< 200 篇** | 当前实现够用 | system prompt = 当前 .md 全文 + 仓库 keyword grep top-5 |
| **200 – 2000 篇** | 把 keyword grep 当 fallback；prompt 加 token 预算 | 同上 + 在 `ai_chat` 前估 token、超限时只保留 retrieve 段 |
| **> 2000 篇 / 严肃 RAG** | 必须做向量检索 | 见下方"演进路径" |

### AI · 上下文检索

### v0.2 起：本地混合检索（向量 + 关键词 + 引用图）

`AIPanel` 发送时按设置组合 system prompt：

```
[ 任务模式 system prompt ]
[ 当前打开的笔记内容，前 6000 字 ]              ← aiUseCurrentFile=true
[ 仓库混合检索片段（top-K，可调）]               ← ragEnabled=true
```

后端模块 `rag/`（见 `src-tauri/src/rag/`）实现：

- `db.rs` — `<workspace>/.markio/rag.db`，5 张表：
  - `docs(path,mtime,size,hash,indexed_at,status)`
  - `chunks(doc_id,ord,heading,char_start,char_end,body,token_count)`
  - `vec_chunks` — sqlite-vec 的 `vec0` 虚表，`embedding float[dim]`，rowid 对齐 `chunks.id`
  - `chunks_fts` — FTS5 外部内容表，`body / heading`，触发器自动同步
  - `links(from_doc,to_path,target_label,kind)`
- `chunk.rs` — 按 ATX 标题层级切段；段内按段落聚合到 `MAX_CHARS=1500`，相邻 chunk overlap `OVERLAP_CHARS=180`
- `embed.rs` — `Ollama (/api/embed)` 与 `OpenAI 兼容 (/v1/embeddings)` 两种 provider；维度由前端按模型设定，DB 端固定后通过 schema_meta 跟踪，模型切维度会自动重建向量表并把所有 doc 标记 stale
- `index.rs` — `reindex_workspace` 全量扫描 / `reindex_file` 单文件增量 / `remove_file` 删除；hash 未变则跳过；进度通过 `RagHandle.db.progress` 暴露给 `rag_status`
- `graph.rs` — 解析 `[[wiki]]` 与本地 `.md` 链接，按 stem 反查仓库文件落到 `links.to_path`
- `search.rs` — 向量 top-K + FTS5 top-K，按 **Reciprocal Rank Fusion** (k=60) 融合；可选启用 forward-link 两跳扩展，命中文档的外向链接再追加 1–2 个 chunk

IPC 命令（见 `lib.rs`）：

| 命令 | 用途 |
| --- | --- |
| `rag_status` | 已索引文档数 / chunk 数 / 库尺寸 / 进度 |
| `rag_reindex` | 全量重建（后台线程跑） |
| `rag_reindex_file` | 单文件刷新（保存后自动触发） |
| `rag_remove_file` | 单文件清理（重命名 / 删除 / 移入回收站后触发） |
| `rag_search` | 混合检索 |
| `rag_clear` | 删库 + WAL/-shm |

并发与运行时：
- 所有 RAG 命令在 `tokio::task::spawn_blocking` 里执行，避免 `rusqlite::Connection` 跨 await 与 `embed_blocking` 内嵌 runtime 冲突
- `RagHandle` 在 `mod.rs` 全局表中按 workspace 缓存，连接复用 + `Mutex` 串行写入

### Mac App Store 上架要点

- sqlite-vec 通过 `rusqlite`（`bundled-full`）静态链接，不依赖外部 .dylib，无需 entitlement 例外
- `.markio/rag.db` 落在 workspace 内，用户已通过 NSOpenPanel 授予路径权限，沙盒兼容
- Ollama 路径走 `http://127.0.0.1:11434`，需要 `com.apple.security.network.client` entitlement（默认已有）
- OpenAI Embedding 走 Rust `reqwest` 代理；API Key 落 Keychain，WebView 不直接连外部模型服务

## 已知 trade-off

- **小仓库的文件名搜索** 仍在前端走（树是已扫好的，filter 是 JS）。> 1 万节点要 Rust 索引
- **当前文档查找** 支持大小写、整词、正则和源码定位；长文档计数走 Rust，preview 高亮仍在 DOM text node 上分发
- **AI 仓库分析** 已经接 sqlite-vec 混合检索 + 引用图谱（见上面「AI · 上下文检索」）。后续可加 reranker（如本地 BGE-reranker）进一步提精度
- **同步能力分层**：Git 命令已接入；WebDAV / S3 / Dropbox / Google Drive 已是双向同步引擎（三方 diff + manifest 基线 + 重试 + 自动调度），剩 newest 跨钟冲突、长同步 TOCTOU、tombstone 落盘待补
- **iOS / Android** 没接 Tauri mobile entry
- **Smart Channel** 仍是实验桥，正式化前不能作为稳定外部接口
