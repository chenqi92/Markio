mod agent_cli;
mod ai;
mod clipper;
mod commands;
mod custom_themes;
mod dev_log;
mod dropbox_ops;
mod frontmatter;
mod fs_ops;
mod gdrive_ops;
mod git_ops;
mod html2md;
mod ignore;
mod import;
mod markdown;
mod mcp;
mod oauth;
mod p2p;
pub mod rag;
mod rss;
mod s3_ops;
mod secrets;
mod smart_channel;
mod state;
mod storefront;
mod watcher;
mod webdav_ops;
mod window_state;

use commands::{
    agent::{agent_cancel, agent_list_providers, agent_run},
    clipper::{
        clipper_set_active_workspace, clipper_set_config, clipper_set_summary, clipper_status,
    },
    dropbox::{
        dropbox_authorize, dropbox_create_folder, dropbox_delete, dropbox_download, dropbox_list,
        dropbox_list_continue, dropbox_signout, dropbox_status, dropbox_upload,
    },
    gdrive::{
        gdrive_authorize, gdrive_create_folder, gdrive_delete, gdrive_download, gdrive_list,
        gdrive_signout, gdrive_status, gdrive_upload,
    },
    git::{
        git_checkout, git_clone, git_commit, git_fetch, git_has_pat, git_init, git_list_branches,
        git_pull, git_push, git_resolve_conflict, git_set_pat, git_status,
    },
    history::{history_list, history_list_all, history_read, history_save},
    icloud::icloud_default_path,
    import::{import_apple_notes, import_list_legacy_dirs, import_run, import_trash_legacy_dir},
    mcp::{mcp_set_active_workspace, mcp_status},
    p2p::{
        p2p_close_pairing, p2p_open_pairing, p2p_set_active_workspace, p2p_set_config, p2p_status,
        p2p_token_delete, p2p_token_get, p2p_token_set,
    },
    rag::{
        rag_cancel, rag_clear, rag_embed_test, rag_reindex, rag_reindex_file, rag_remove_file,
        rag_repo_graph, rag_search, rag_status,
    },
    rss::rss_fetch,
    s3::{
        s3_delete_object, s3_get_object, s3_has_secret, s3_list_objects, s3_put_object,
        s3_set_secret,
    },
    secret::{secret_copy, secret_delete, secret_get, secret_has, secret_set},
    smart_channel::{smart_channel_respond, smart_channel_set_config, smart_channel_status},
    theme::{theme_delete, theme_dir_path, theme_import, theme_list, theme_read},
    webdav::{
        webdav_delete, webdav_get, webdav_has_password, webdav_list, webdav_mkcol, webdav_put,
        webdav_set_password, webdav_test,
    },
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use tauri::{Emitter, Manager};

use ai::{AgentRequest, AgentTurnResult, ChatRequest, ChatResponse};
use fs_ops::{AiContext, Attachment, Backlink, FileEntry, GrepHit, TrashItem};
use markdown::{OutlineItem, RenderResult};
use state::{ensure_in_workspaces, hash64, signature_for, signature_for_bytes, AppState, FileSig};

static MD_STREAM_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn md_stream_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    MD_STREAM_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII：drop 时（含 spawn_blocking 内 panic）自动从注册表移除，避免长跑累积。
struct MdStreamCancelGuard {
    id: String,
}

impl Drop for MdStreamCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = md_stream_cancels().lock() {
            guard.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigDto {
    pub mtime: i64,
    pub hash: String,
}
impl From<FileSig> for SigDto {
    fn from(s: FileSig) -> Self {
        Self {
            mtime: s.mtime_ms,
            hash: format!("{:x}", s.hash),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub content: String,
    pub sig: SigDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePasteRequest {
    pub workspace: String,
    pub note: String,
    pub file_name: Option<String>,
    pub mime: String,
    pub data_base64: String,
    pub upload: bool,
    pub keep_local: bool,
    pub endpoint: Option<String>,
    /// 写盘前是否压缩。PNG → 重编码 + best filter；JPEG → 走给定 quality；
    /// WebP / GIF → 走 image crate 默认 encoder。None / Some(false) 视为关闭。
    pub compress: Option<bool>,
    /// JPEG / WebP quality (1-100)；None 取 85 默认值。
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePasteResult {
    pub markdown: String,
    pub url: String,
    pub local_path: Option<String>,
    pub uploaded: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFileEntry {
    pub rel_path: String,
    pub mtime: i64,
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PicgoPingResult {
    pub ok: bool,
    pub status: u16,
    pub latency_ms: u64,
    pub message: Option<String>,
}

const MAX_IMAGE_INPUT_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 80_000_000;
pub(crate) const MAX_SYNC_BODY_BYTES: usize = 50 * 1024 * 1024;
const MAX_CRASH_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_CRASH_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_CRASH_READ_BYTES: u64 = 512 * 1024;

/// 生成 32 字节随机 token（hex）。loopback HTTP / WS server 鉴权共用（mcp/clipper/smart_channel/p2p）。
/// CSPRNG 不可用时 fail-closed（panic）而非退化成可预测的时间戳——宁可拒绝启动也不签发弱 token。
pub(crate) fn random_loopback_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("系统 CSPRNG 不可用，无法安全生成 loopback token");
    hex::encode(buf)
}

/// 常量时间字符串比较，避免 token 校验产生计时侧信道。loopback server 鉴权共用。
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

pub(crate) fn validate_path(state: &AppState, p: &str) -> Result<PathBuf, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| format!("internal lock: {e}"))?;
    ensure_in_workspaces(&inner.workspaces, Path::new(p))
}

fn workspace_roots(state: &AppState) -> Result<Vec<PathBuf>, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| format!("internal lock: {e}"))?;
    Ok(inner.workspaces.iter().cloned().collect())
}

fn containing_workspace(state: &AppState, target: &Path) -> Result<Option<PathBuf>, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| format!("internal lock: {e}"))?;
    Ok(inner
        .workspaces
        .iter()
        .filter(|root| target.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned())
}

pub(crate) fn workspace_for_path(state: &AppState, target: &Path) -> Result<PathBuf, String> {
    containing_workspace(state, target)?.ok_or_else(|| "路径不在任何已注册仓库中".to_string())
}

fn is_internal_path(workspace: &Path, target: &Path) -> bool {
    target.starts_with(workspace.join(".markio"))
}

pub(crate) fn ensure_user_file_path(
    state: &AppState,
    target: &Path,
    action: &str,
) -> Result<(), String> {
    let ws = workspace_for_path(state, target)?;
    if target == ws {
        return Err(format!("拒绝{action}：不能操作仓库根目录"));
    }
    if is_internal_path(&ws, target) {
        return Err(format!("拒绝{action}：不能操作 Markio 内部数据目录"));
    }
    Ok(())
}

fn ensure_same_workspace(state: &AppState, a: &Path, b: &Path) -> Result<PathBuf, String> {
    let wa = workspace_for_path(state, a)?;
    let wb = workspace_for_path(state, b)?;
    if wa != wb {
        return Err("拒绝跨仓库移动文件".to_string());
    }
    Ok(wa)
}

pub(crate) fn ensure_history_path(workspace: &Path, path: &Path) -> Result<(), String> {
    let history = workspace.join(".markio").join("history");
    if path.starts_with(history) {
        Ok(())
    } else {
        Err("拒绝读取：历史快照路径无效".to_string())
    }
}

pub(crate) fn ensure_path_in_workspace(
    workspace: &Path,
    file: &Path,
    action: &str,
) -> Result<(), String> {
    if file.starts_with(workspace) {
        Ok(())
    } else {
        Err(format!("拒绝{action}：文件不属于所选仓库"))
    }
}

pub(crate) fn validate_body_size(
    label: &str,
    raw_base64: &str,
    max_bytes: usize,
) -> Result<(), String> {
    let estimate = raw_base64.trim().len().saturating_mul(3) / 4;
    if estimate > max_bytes {
        return Err(format!(
            "{label} 超过大小限制：最大 {} MB",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(())
}

pub(crate) fn validate_http_service_url(input: &str, label: &str) -> Result<reqwest::Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} 地址为空"));
    }
    let url = reqwest::Url::parse(trimmed).map_err(|e| format!("{label} 地址无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{label} 仅支持 http/https"));
    }
    if url.scheme() == "http" && !is_loopback_host(url.host_str()) {
        return Err(format!("{label} 不允许使用非本机 http 明文连接"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} 地址不能包含用户名或密码"));
    }
    if url.fragment().is_some() || url.query().is_some() {
        return Err(format!("{label} 地址不能包含 query 或 fragment"));
    }
    Ok(url)
}

pub(crate) fn remote_account(prefix: &str, endpoint: &str) -> Result<String, String> {
    let url = validate_http_service_url(endpoint, prefix)?;
    let host = url
        .host_str()
        .ok_or_else(|| format!("{prefix} 地址缺少 host"))?
        .to_ascii_lowercase();
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    Ok(format!("{prefix}:{authority}"))
}

pub(crate) fn validate_remote_rel_path(path: &str, allow_empty: bool) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err("远端路径不能为空".to_string())
        };
    }
    if normalized.starts_with('/') {
        return Err("远端路径不能以 / 开头".to_string());
    }
    if normalized.contains('\n') || normalized.contains('\r') || normalized.contains('\0') {
        return Err("远端路径包含非法控制字符".to_string());
    }
    if normalized
        .split('/')
        .any(|seg| seg == "." || seg == ".." || seg.is_empty())
    {
        return Err("远端路径不能包含空段、. 或 ..".to_string());
    }
    Ok(())
}

// ─── markdown ───────────────────────────────────────────────────────

#[tauri::command]
async fn md_render(
    state: tauri::State<'_, AppState>,
    source: String,
    base_path: Option<String>,
) -> Result<RenderResult, String> {
    let roots = workspace_roots(&state).unwrap_or_default();
    let base = base_path
        .as_deref()
        .and_then(|path| validate_path(&state, path).ok());
    // 渲染含 pulldown 解析 + syntect 高亮 + 图片内联 + ammonia 清洗，是 CPU 密集活。
    // 非 async 命令会在主线程(事件循环)上跑，整段时间窗口拖拽/托盘/其它 IPC 全冻结。
    // 放到 spawn_blocking，与 md_render_stream 一致。
    tokio::task::spawn_blocking(move || markdown::render(&source, base.as_deref(), &roots))
        .await
        .map_err(|e| format!("render join 失败：{e}"))
}

#[tauri::command]
fn md_outline(source: String) -> Vec<OutlineItem> {
    markdown::outline_only(&source)
}

#[tauri::command]
fn app_storefront_country_code() -> Option<String> {
    storefront::country_code()
}

/// 流式渲染：按一级标题切片，每片单独渲染 HTML 并通过事件发出。
/// 标题前的导言、跨片的 outline 都合并完整返回；前端可在 split 视图
/// 大文档下选择订阅事件追加 HTML，避免一次性卡顿。
///
/// 事件 channel：`md-stream-{stream_id}`，payload 形如：
///   { event: "chunk", index, html }
///   { event: "done",  outline, words, readingMinutes }
///   { event: "error", message }
#[tauri::command]
async fn md_render_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    stream_id: String,
    source: String,
    base_path: Option<String>,
) -> Result<(), String> {
    let roots = workspace_roots(&state).unwrap_or_default();
    let base = base_path
        .as_deref()
        .and_then(|path| validate_path(&state, path).ok());
    let app2 = app.clone();
    let id = stream_id.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    md_stream_cancels()
        .lock()
        .map_err(|e| format!("stream cancel lock: {e}"))?
        .insert(stream_id, cancel.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MdStreamCancelGuard { id: id.clone() };
        let channel = format!("md-stream-{id}");
        // 按 H1 切片：以行首 `# ` 起一段；首段（导言）可能无标题。
        // 必须跳过代码围栏内的 `# `（如 ```bash 里的 `# install deps`），否则会在
        // 围栏中间切断，前段围栏不闭合、后段把注释当 H1，大文档预览整体错乱。
        let mut sections: Vec<String> = Vec::new();
        let mut current = String::new();
        let mut in_fence = false;
        let mut fence_marker = "";
        for line in source.split_inclusive('\n') {
            let trimmed = line.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                let marker = if trimmed.starts_with("```") {
                    "```"
                } else {
                    "~~~"
                };
                if !in_fence {
                    in_fence = true;
                    fence_marker = marker;
                } else if trimmed.starts_with(fence_marker) {
                    in_fence = false;
                }
            }
            if !in_fence && line.starts_with("# ") && !current.is_empty() {
                sections.push(std::mem::take(&mut current));
            }
            current.push_str(line);
        }
        if !current.is_empty() {
            sections.push(current);
        }
        if sections.is_empty() {
            sections.push(String::new());
        }
        // 累计每段在原文中的起始行号，作为 data-line 偏移传给 render；
        // 否则每段都从 1 开始计数，前端 anchors 非单调，分屏 scroll sync 错位
        let mut line_offset: usize = 0;
        for (idx, sec) in sections.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let r = markdown::render_with_line_offset(sec, base.as_deref(), &roots, line_offset);
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let _ = app2.emit(
                &channel,
                serde_json::json!({
                    "event": "chunk",
                    "index": idx,
                    "html": r.html,
                }),
            );
            line_offset += sec.matches('\n').count();
        }
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        // 统计信息只解析标题和字数，避免流式渲染后又完整高亮 / 清洗一遍全文。
        let (outline, words, reading_minutes) = markdown::metadata_only(&source);
        let _ = app2.emit(
            &channel,
            serde_json::json!({
                "event": "done",
                "outline": outline,
                "words": words,
                "readingMinutes": reading_minutes,
            }),
        );
    });
    Ok(())
}

#[tauri::command]
fn md_cancel_stream(stream_id: String) -> Result<(), String> {
    if let Some(cancel) = md_stream_cancels()
        .lock()
        .map_err(|e| format!("stream cancel lock: {e}"))?
        .remove(&stream_id)
    {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ─── workspace 注册 ─────────────────────────────────────────────────

#[tauri::command]
fn workspace_register(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let canon = state.register_workspace(Path::new(&path))?;
    // 注册文件监听；失败不阻塞注册流程
    if let Err(e) = watcher::watch(app.clone(), canon.clone()) {
        eprintln!("[workspace] 启动 watcher 失败：{e}");
    }
    Ok(canon.to_string_lossy().to_string())
}

#[tauri::command]
fn workspace_unregister(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = state.unregister_workspace(Path::new(&path))?;
    watcher::unwatch(&canon);
    Ok(canon.to_string_lossy().to_string())
}

/// 返回各 workspace 的文件监听健康度。前端可定期（例如 30s）拉取，
/// 若 backend_errors 持续上升或 last_event_at 与本地编辑明显脱节，
/// 提示用户重启或重建 RAG 索引（FSEvents 在系统休眠 / iCloud 重新挂载等场景会哑）。
#[tauri::command]
fn watcher_health() -> Vec<watcher::WatcherHealthDto> {
    watcher::health_snapshot()
}

// ─── 树 & 文件 ──────────────────────────────────────────────────────

#[tauri::command]
async fn fs_read_tree(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<FileEntry, String> {
    let canon = validate_path(&state, &path)?;
    let root = canon.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || fs_ops::walk_tree(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_read_dir(state: tauri::State<'_, AppState>, path: String) -> Result<FileEntry, String> {
    let canon = validate_path(&state, &path)?;
    let root = canon.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || fs_ops::read_dir_shallow(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// 读取文件 + 记录指纹，前端用 sig 在保存时校验
#[tauri::command]
fn fs_open(state: tauri::State<'_, AppState>, path: String) -> Result<OpenedFile, String> {
    let canon = validate_path(&state, &path)?;
    let content = fs_ops::read_text_path(&canon)?;
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(OpenedFile {
        path: canon.to_string_lossy().to_string(),
        content,
        sig: sig.into(),
    })
}

/// 只读文件内容，不记录保存基线。
///
/// 用于 AI 引用、导入预览等只读场景，避免把这些临时读取误登记成
/// “用户已打开并准备保存”的文件指纹。
#[tauri::command]
fn fs_read_text(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::read_text_path(&canon)
}

#[tauri::command]
fn fs_read_file_base64(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = validate_path(&state, &path)?;
    read_file_base64_checked(&canon)
}

fn modified_ms_for_path(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_sync_rel_path(rel_path: &str) -> Result<String, String> {
    let normalized = rel_path.replace('\\', "/");
    validate_remote_rel_path(&normalized, false)?;
    if normalized
        .split('/')
        .any(|segment| segment.starts_with('.') || segment.eq_ignore_ascii_case(".markio"))
    {
        return Err("同步路径不能包含隐藏目录或 Markio 内部目录".to_string());
    }
    Ok(normalized)
}

pub(crate) fn resolve_sync_user_path(
    state: &AppState,
    workspace: &str,
    rel_path: &str,
) -> Result<PathBuf, String> {
    let ws = validate_path(state, workspace)?;
    let rel = validate_sync_rel_path(rel_path)?;
    let target = ws.join(rel);
    let canon = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| format!("同步路径无效：{e}"))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| "同步路径没有父目录".to_string())?;
        let parent_canon = parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf());
        let file_name = target
            .file_name()
            .ok_or_else(|| "同步路径文件名无效".to_string())?;
        parent_canon.join(file_name)
    };
    ensure_path_in_workspace(&ws, &canon, "同步")?;
    ensure_user_file_path(state, &canon, "同步")?;
    Ok(canon)
}

pub(crate) fn read_file_base64_checked(canon: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(canon).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !meta.is_file() {
        return Err("读取文件失败：目标不是文件".to_string());
    }
    if meta.len() > MAX_SYNC_BODY_BYTES as u64 {
        return Err(format!(
            "文件超过上传大小限制：最大 {} MB",
            MAX_SYNC_BODY_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(canon).map_err(|e| format!("读取文件失败：{e}"))?;
    Ok(STANDARD.encode(bytes))
}

pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败：{e}"))?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("markio")
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换文件失败：{e}")
    })
}

fn sync_file_entry(
    root: &Path,
    path: &Path,
    meta: &std::fs::Metadata,
) -> Result<SyncFileEntry, String> {
    let rel = path
        .strip_prefix(root)
        .map_err(|_| "同步扫描路径不在仓库中".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let bytes = std::fs::read(path).map_err(|e| format!("读取同步文件失败：{e}"))?;
    Ok(SyncFileEntry {
        rel_path: rel,
        mtime: modified_ms_for_path(path),
        hash: format!("{:x}", hash64(&bytes)),
        size: meta.len(),
    })
}

#[tauri::command]
async fn fs_sync_scan(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<SyncFileEntry>, String> {
    let ws = validate_path(&state, &workspace)?;
    // 整库读+哈希每个文件，主线程跑会冻结窗口；放 spawn_blocking。
    tokio::task::spawn_blocking(move || sync_scan_workspace(&ws))
        .await
        .map_err(|e| format!("sync scan join 失败：{e}"))
}

/// 扫描仓库返回同步用文件清单（rel_path / mtime / FNV hash / size）。
/// 供 fs_sync_scan 命令与 P2P 金库 RPC server 共用，保证两侧 hash 口径一致。
pub(crate) fn sync_scan_workspace(ws: &Path) -> Vec<SyncFileEntry> {
    use crate::ignore::IgnoreRules;
    let rules = IgnoreRules::load(ws);
    let mut out = Vec::new();
    let ws = ws.to_path_buf();
    let mut stack = vec![(ws.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > 16 || out.len() > 20_000 {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            let rel = path.strip_prefix(&ws).ok();
            if rel.is_some_and(|rel| rules.is_ignored(rel, ft.is_dir())) {
                continue;
            }
            if ft.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > MAX_SYNC_BODY_BYTES as u64 {
                // 超大文件不读全文哈希，但**仍要列出**（用 oversize 标记 + 元数据）。
                // 否则它从扫描里凭空消失，diff 会把「有基线但本地没了」当成删除，
                // 进而删掉远端副本——这是真实数据丢失（已同步的附件长大超限即被删）。
                // 前端 diff 见到 oversize:* 哈希会跳过该文件的任何动作。
                if let Ok(rel) = path.strip_prefix(&ws) {
                    out.push(SyncFileEntry {
                        rel_path: rel.to_string_lossy().replace('\\', "/"),
                        mtime: modified_ms_for_path(&path),
                        hash: format!("oversize:{}", meta.len()),
                        size: meta.len(),
                    });
                }
                continue;
            }
            match sync_file_entry(&ws, &path, &meta) {
                Ok(item) => out.push(item),
                Err(e) => eprintln!("[sync.scan] 跳过 {}：{e}", path.display()),
            }
        }
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

#[tauri::command]
fn fs_sync_read_file_base64(
    state: tauri::State<'_, AppState>,
    workspace: String,
    rel_path: String,
) -> Result<String, String> {
    let path = resolve_sync_user_path(&state, &workspace, &rel_path)?;
    read_file_base64_checked(&path)
}

#[tauri::command]
fn fs_sync_write_file_base64(
    state: tauri::State<'_, AppState>,
    workspace: String,
    rel_path: String,
    body_base64: String,
) -> Result<SigDto, String> {
    validate_body_size("同步写入内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let path = resolve_sync_user_path(&state, &workspace, &rel_path)?;
    let bytes = STANDARD
        .decode(body_base64.trim())
        .map_err(|e| format!("同步内容不是合法 base64：{e}"))?;
    atomic_write_bytes(&path, &bytes)?;
    let sig = signature_for(&path).map_err(|e| e.to_string())?;
    Ok(sig.into())
}

#[tauri::command]
fn fs_sync_soft_delete(
    state: tauri::State<'_, AppState>,
    workspace: String,
    rel_path: String,
) -> Result<SigDto, String> {
    let ws = validate_path(&state, &workspace)?;
    let path = resolve_sync_user_path(&state, &workspace, &rel_path)?;
    let sig = signature_for(&path).map_err(|e| e.to_string())?;
    fs_ops::trash_move(&ws.to_string_lossy(), &path.to_string_lossy())?;
    Ok(sig.into())
}

fn validate_manifest_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty()
        || id.len() > 48
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("同步 manifest id 无效".to_string());
    }
    Ok(id.to_string())
}

fn sync_manifest_path(workspace: &Path, id: &str) -> Result<PathBuf, String> {
    let id = validate_manifest_id(id)?;
    Ok(workspace
        .join(".markio")
        .join("sync")
        .join(format!("{id}.json")))
}

#[tauri::command]
fn fs_sync_manifest_read(
    state: tauri::State<'_, AppState>,
    workspace: String,
    id: String,
) -> Result<Option<String>, String> {
    let ws = validate_path(&state, &workspace)?;
    let path = sync_manifest_path(&ws, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取 manifest 信息失败：{e}"))?;
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
        return Err("同步 manifest 无效或过大".to_string());
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("读取同步 manifest 失败：{e}"))
}

#[tauri::command]
fn fs_sync_manifest_write(
    state: tauri::State<'_, AppState>,
    workspace: String,
    id: String,
    content: String,
) -> Result<(), String> {
    if content.len() > 2 * 1024 * 1024 {
        return Err("同步 manifest 过大".to_string());
    }
    let ws = validate_path(&state, &workspace)?;
    let path = sync_manifest_path(&ws, &id)?;
    fs_ops::atomic_write(&path, &content)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFileBase64 {
    path: String,
    name: String,
    body_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FileDialogFilter {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
async fn fs_pick_file_base64(
    app: tauri::AppHandle,
    filters: Option<Vec<FileDialogFilter>>,
) -> Result<Option<PickedFileBase64>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file().set_title("选择上传文件");
        for filter in filters.unwrap_or_default() {
            let refs = filter
                .extensions
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            dialog = dialog.add_filter(filter.name, &refs);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|e| format!("选择文件失败：{e}"))?;

    let Some(path) = picked else {
        return Ok(None);
    };
    let raw_path = path
        .into_path()
        .map_err(|e| format!("选择文件路径无效：{e}"))?;
    let canon = std::fs::canonicalize(&raw_path).map_err(|e| format!("读取文件失败：{e}"))?;
    let name = canon
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "upload.bin".to_string());
    let body_base64 = read_file_base64_checked(&canon)?;
    Ok(Some(PickedFileBase64 {
        path: canon.to_string_lossy().to_string(),
        name,
        body_base64,
    }))
}

#[tauri::command]
fn fs_close(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    // 文件可能已被外部删除（用户在 Finder 删了再点 close），validate_path 走的
    // ensure_in_workspaces 已支持"文件不存在但父目录在 workspace"。
    // 极端情况（父目录都没了）直接静默返回——opened 表里那条残留 entry 不影响功能，
    // 强行 unwrap 到 raw path 反而会污染表（破坏"key 全是 canon"不变量）。
    let Ok(canon) = validate_path(&state, &path) else {
        return Ok(());
    };
    state.record_close(&canon)
}

fn parse_expected_hash(raw: &str) -> Result<u64, String> {
    let trimmed = raw.trim().trim_start_matches("0x");
    if trimmed.is_empty() {
        return Err("保存失败：文件基线哈希为空，请重新打开文件后再保存。".to_string());
    }
    u64::from_str_radix(trimmed, 16)
        .map_err(|_| "保存失败：文件基线哈希无效，请重新打开文件后再保存。".to_string())
}

fn disk_changed_since_baseline(
    disk: FileSig,
    known: Option<FileSig>,
    expected_mtime: Option<i64>,
    expected_hash: Option<&str>,
) -> Result<Option<bool>, String> {
    if let Some(hash) = expected_hash.filter(|hash| !hash.trim().is_empty()) {
        return Ok(Some(disk.hash != parse_expected_hash(hash)?));
    }
    if let Some(mtime) = expected_mtime {
        return Ok(Some(disk.mtime_ms != mtime));
    }
    if let Some(known) = known {
        return Ok(Some(disk.hash != known.hash));
    }
    Ok(None)
}

/// 原子保存 + 冲突检测。
/// - `expected_mtime` / `expected_hash` 是调用方打开 / 上次保存时记下的基线
/// - 调用方基线优先于进程内 opened 表，避免旧标签覆盖新标签保存过的内容
/// - `force` 表示用户主动覆盖
/// - `snapshot_on_save` 表示调用方希望本次写入前保存旧版本快照
/// - 返回新 sig；冲突时返回 Err("CONFLICT:<current_mtime>:<current_hash>")
#[tauri::command]
fn fs_save(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
    expected_hash: Option<String>,
    force: Option<bool>,
    snapshot_on_save: Option<bool>,
) -> Result<SigDto, String> {
    let canon = validate_path(&state, &path)?;
    ensure_user_file_path(&state, &canon, "保存")?;
    let forced = force.unwrap_or(false);
    let old_content = if canon.exists() {
        Some(fs_ops::read_text_path(&canon)?)
    } else {
        None
    };
    if !forced {
        // 检查磁盘上是否被改过
        if old_content.as_ref().is_some() {
            let disk = signature_for(&canon).map_err(|e| e.to_string())?;
            let known = state.last_sig(&canon);
            let changed =
                disk_changed_since_baseline(disk, known, expected_mtime, expected_hash.as_deref())?
                    .ok_or_else(|| format!("BASELINE_REQUIRED:{}", canon.to_string_lossy()))?;
            if changed {
                return Err(format!("CONFLICT:{}:{:x}", disk.mtime_ms, disk.hash));
            }
        }
    }
    if snapshot_on_save.unwrap_or(true) {
        if let Some(old) = old_content.as_ref().filter(|old| old.as_str() != content) {
            if let Some(ws) = containing_workspace(&state, &canon)? {
                if let Err(e) =
                    fs_ops::save_snapshot(&ws.to_string_lossy(), &canon.to_string_lossy(), old)
                {
                    eprintln!("[history.save] 保存旧版本失败：{e}");
                }
            }
        }
    }
    fs_ops::atomic_write(&canon, &content)?;
    // 刚原子写入的内容就是 content.as_bytes()，直接据此算 sig，省掉一次整文件回读。
    let sig = signature_for_bytes(&canon, content.as_bytes()).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(sig.into())
}

/// 创建新文件，已存在时返回 Err("ALREADY_EXISTS:<path>")
#[tauri::command]
fn fs_create_new(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
) -> Result<SigDto, String> {
    let canon = validate_path(&state, &path)?;
    ensure_user_file_path(&state, &canon, "创建")?;
    fs_ops::create_new(&canon, &content)?;
    let sig = signature_for_bytes(&canon, content.as_bytes()).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(sig.into())
}

#[tauri::command]
fn fs_rename(state: tauri::State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    let from_p = validate_path(&state, &from)?;
    let to_p = validate_path(&state, &to)?;
    ensure_same_workspace(&state, &from_p, &to_p)?;
    ensure_user_file_path(&state, &from_p, "重命名")?;
    ensure_user_file_path(&state, &to_p, "重命名")?;
    fs_ops::rename(&from_p.to_string_lossy(), &to_p.to_string_lossy())?;
    state.record_close(&from_p)?;
    Ok(())
}

/// 改名 / 移动 markdown 文件后，改写仓库内其它笔记里指向旧名的 `[[wikilink]]`。
/// 应在 `fs_rename` 成功之后调用（此时 to 已存在、from 已不存在）。
/// 每个被改写的文件先存历史快照再原子写；返回被改写文件的绝对路径列表。尽力而为：
/// 单个文件失败不影响其它文件，改名本身不依赖它。
#[tauri::command]
async fn fs_update_wikilinks(
    state: tauri::State<'_, AppState>,
    workspace: String,
    from: String,
    to: String,
) -> Result<Vec<String>, String> {
    let ws = validate_path(&state, &workspace)?;
    let to_p = validate_path(&state, &to)?;
    let ws_s = ws.to_string_lossy().to_string();
    let to_s = to_p.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        fs_ops::update_wikilinks_on_rename(&ws_s, &from, &to_s)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn fs_delete(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    ensure_user_file_path(&state, &canon, "删除")?;
    fs_ops::delete(&canon.to_string_lossy())?;
    state.record_close(&canon)?;
    Ok(())
}

#[tauri::command]
fn fs_mkdir(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    ensure_user_file_path(&state, &canon, "创建目录")?;
    fs_ops::make_dir(&canon.to_string_lossy())
}

#[tauri::command]
async fn fs_grep(
    state: tauri::State<'_, AppState>,
    root: String,
    query: String,
    max: Option<usize>,
) -> Result<Vec<GrepHit>, String> {
    let canon = validate_path(&state, &root)?;
    let root_str = canon.to_string_lossy().to_string();
    let max = max.unwrap_or(80);
    // root 恰好是已注册仓库时，优先用 RAG 的 FTS5 索引；
    // 失败 / 索引不存在 / 子目录都回退暴力扫
    let workspace_match = workspace_roots(&state)
        .ok()
        .and_then(|roots| roots.into_iter().find(|r| r == &canon));
    let q = query.clone();
    let hits = tauri::async_runtime::spawn_blocking(move || -> Vec<GrepHit> {
        if let Some(ws) = workspace_match {
            if let Some(fts_hits) = fts_grep_on_workspace(&ws, &q, max) {
                if !fts_hits.is_empty() {
                    return fts_hits;
                }
            }
        }
        fs_ops::grep(&root_str, &q, max)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(hits)
}

/// 用 RAG 的 FTS5 索引做关键字检索；DB 不存在 / 查询失败时返回 None。
fn fts_grep_on_workspace(workspace: &Path, query: &str, max: usize) -> Option<Vec<GrepHit>> {
    if query.is_empty() {
        return None;
    }
    let db_path = rag::db::db_path(workspace);
    if !db_path.exists() {
        return None;
    }
    let conn =
        rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    // FTS 表达式：对每个词加 `*` 前缀，词间 OR
    let safe = query
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '(' | ')' | ',' | ';'))
        .filter_map(|w| {
            let t: String = w.chars().filter(|c| !c.is_control() && *c != '*').collect();
            if t.is_empty() {
                None
            } else {
                Some(format!("\"{}\"*", t.replace('"', "\"\"")))
            }
        })
        .collect::<Vec<_>>()
        .join(" OR ");
    if safe.is_empty() {
        return None;
    }
    let mut stmt = conn
        .prepare(
            "SELECT d.path, c.heading, c.body FROM chunks_fts \
             JOIN chunks c ON c.id = chunks_fts.rowid \
             JOIN docs d ON d.id = c.doc_id \
             WHERE chunks_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![safe, max as i64], |r| {
            let path: String = r.get(0)?;
            let heading: String = r.get(1)?;
            let body: String = r.get(2)?;
            Ok((path, heading, body))
        })
        .ok()?;
    let mut out: Vec<GrepHit> = Vec::new();
    let needle = query.to_lowercase();
    for row in rows.flatten() {
        let (path, heading, body) = row;
        // 找到 needle 第一次出现位置，截 ±60 字符当 snippet
        let lower = body.to_lowercase();
        let pos = lower.find(&needle).unwrap_or(0);
        let start = pos.saturating_sub(60);
        let end = (pos + needle.len() + 60).min(body.len());
        // 字符边界保护
        let safe_end = body
            .char_indices()
            .map(|(i, _)| i)
            .take_while(|&i| i <= end)
            .last()
            .unwrap_or(body.len());
        let safe_start = body
            .char_indices()
            .map(|(i, _)| i)
            .rfind(|&i| i <= start)
            .unwrap_or(0);
        let snippet: String = body[safe_start..safe_end].to_string();
        let name = std::path::Path::new(&path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&path)
            .to_string();
        out.push(GrepHit {
            path,
            name: if heading.is_empty() {
                name
            } else {
                format!("{name} · {heading}")
            },
            line: 0,
            preview: snippet,
        });
    }
    Some(out)
}

#[tauri::command]
fn fs_reveal(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::reveal_in_os(&canon.to_string_lossy())
}

#[tauri::command]
async fn fs_list_attachments(
    state: tauri::State<'_, AppState>,
    workspace: String,
    max: Option<usize>,
) -> Result<Vec<Attachment>, String> {
    let canon = validate_path(&state, &workspace)?;
    let workspace = canon.to_string_lossy().to_string();
    let max = max.unwrap_or(200);
    let items =
        tauri::async_runtime::spawn_blocking(move || fs_ops::list_attachments(&workspace, max))
            .await
            .map_err(|e| e.to_string())?;
    Ok(items)
}

fn image_ext_from_mime(mime: &str, file_name: Option<&str>) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "image/tiff" => "tiff",
        _ => file_name
            .and_then(|name| Path::new(name).extension())
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .and_then(|ext| match ext.as_str() {
                "jpg" | "jpeg" => Some("jpg"),
                "png" => Some("png"),
                "gif" => Some("gif"),
                "webp" => Some("webp"),
                "bmp" => Some("bmp"),
                "svg" => Some("svg"),
                "tif" | "tiff" => Some("tiff"),
                _ => None,
            })
            .unwrap_or("png"),
    }
}

fn sanitize_file_stem(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "image".to_string()
    } else {
        out
    }
}

fn markdown_alt(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

fn normalize_picgo_endpoint(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("PicGo API 端点为空".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("PicGo API 端点无效：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("PicGo API 仅支持 http/https".to_string());
    }
    if !is_loopback_host(parsed.host_str()) {
        return Err("PicGo API 仅允许连接本机地址".to_string());
    }
    if trimmed.ends_with("/upload") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/upload"))
    }
}

fn picgo_result_url(value: &Value) -> Option<String> {
    value
        .pointer("/result/0")
        .and_then(Value::as_str)
        .or_else(|| value.pointer("/data/0").and_then(Value::as_str))
        .or_else(|| value.pointer("/data/url").and_then(Value::as_str))
        .or_else(|| value.get("url").and_then(Value::as_str))
        .map(ToString::to_string)
}

async fn upload_with_picgo(endpoint: &str, file_path: &Path) -> Result<String, String> {
    let url = normalize_picgo_endpoint(endpoint)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| format!("创建 PicGo 客户端失败：{e}"))?;
    let body = serde_json::json!({
        "list": [file_path.to_string_lossy().to_string()]
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("无法连接 PicGo：{e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取 PicGo 响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("PicGo 返回 HTTP {status}：{text}"));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("PicGo 响应不是 JSON：{e}"))?;
    if value
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
    {
        let msg = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("PicGo 上传失败");
        return Err(msg.to_string());
    }
    picgo_result_url(&value).ok_or_else(|| "PicGo 响应中没有图片 URL".to_string())
}

// ─── 系统托盘 ──────────────────────────────────────────────────────
//
// 在 setup() 里建一个 id="main" 的 TrayIcon；前端通过 tray_set_visible
// 命令显隐。点击托盘 → 显示并聚焦主窗口；右键菜单提供 "显示窗口" / "退出"。

const TRAY_ID: &str = "main";

fn show_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn install_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
    let show_item = MenuItemBuilder::with_id("tray_show", "显示窗口")
        .build(app)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItemBuilder::with_id("tray_quit", "退出 markio")
        .build(app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
        .map_err(|e| e.to_string())?;
    TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("markio")
        .icon(app.default_window_icon().cloned().ok_or("缺少默认图标")?)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn tray_set_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(visible).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 拉取一张远端图片并 base64 内联，用于 exportHtml 的离线导出。
/// 失败时返回原 url（让 HTML 里仍然是 http(s) 链接，不影响在线打开）。
#[tauri::command]
async fn fetch_image_as_data_url(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http/https".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL 不能包含用户名 / 密码".to_string());
    }
    reject_private_network_url(&parsed, "图片下载")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(safe_redirect_policy())
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("单张图片超过 10MB 上限".to_string());
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 把文本写到用户通过 dialog.save 选定的绝对路径。
/// 限制写入位置必须落在当前仓库或常用用户目录（Desktop/Documents/Downloads）内，
/// 避免被 webview 滥用成任意文件覆盖原语（覆盖启动脚本 / 配置）。
#[tauri::command]
async fn export_write_file(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    if path.contains('\0') {
        return Err("路径含非法字符".to_string());
    }
    if content.len() > 64 * 1024 * 1024 {
        return Err("导出内容过大（>64MB）".to_string());
    }
    let dest = std::path::Path::new(&path);
    if !dest.is_absolute() {
        return Err("导出路径必须是绝对路径".to_string());
    }
    if dest.exists() && dest.is_dir() {
        return Err("导出目标不能是文件夹".to_string());
    }
    let parent = dest
        .parent()
        .ok_or_else(|| "导出路径缺少父目录".to_string())?;
    if !parent.as_os_str().is_empty() && !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("导出目录无效：{e}"))?;
    let allowed = common_export_roots(&state)
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| parent_canon.starts_with(&root));
    if !allowed {
        return Err(
            "导出位置不在当前仓库或常用用户目录（Desktop/Documents/Downloads）中".to_string(),
        );
    }
    std::fs::write(dest, content).map_err(|e| format!("写入失败：{e}"))
}

/// 整库静态站点导出：把 content 写到 out_dir/rel_path。out_dir 必须落在常用导出根内，
/// rel_path 只允许普通相对路径（拒绝绝对 / 盘符 / `..` 穿越）。
#[tauri::command]
async fn export_site_write(
    state: tauri::State<'_, AppState>,
    out_dir: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    use std::path::{Component, Path, PathBuf};
    if out_dir.is_empty() || rel_path.is_empty() {
        return Err("路径为空".to_string());
    }
    if out_dir.contains('\0') || rel_path.contains('\0') {
        return Err("路径含非法字符".to_string());
    }
    if content.len() > 64 * 1024 * 1024 {
        return Err("导出内容过大（>64MB）".to_string());
    }
    let base = Path::new(&out_dir);
    if !base.is_absolute() {
        return Err("导出目录必须是绝对路径".to_string());
    }
    let rel = Path::new(&rel_path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("非法的导出相对路径".to_string());
    }
    std::fs::create_dir_all(base).map_err(|e| format!("创建导出目录失败：{e}"))?;
    let base_canon = base
        .canonicalize()
        .map_err(|e| format!("导出目录无效：{e}"))?;
    let allowed = common_export_roots(&state)
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| base_canon.starts_with(&root));
    if !allowed {
        return Err(
            "导出位置不在当前仓库或常用用户目录（Desktop/Documents/Downloads）中".to_string(),
        );
    }
    let dest: PathBuf = base_canon.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&dest, content).map_err(|e| format!("写入失败：{e}"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePasteFromDiskRequest {
    pub workspace: String,
    pub note: String,
    pub src_path: String,
    pub upload: bool,
    pub keep_local: bool,
    pub endpoint: Option<String>,
    pub compress: Option<bool>,
    pub quality: Option<u8>,
}

#[tauri::command]
async fn image_paste_from_disk(
    state: tauri::State<'_, AppState>,
    req: ImagePasteFromDiskRequest,
) -> Result<ImagePasteResult, String> {
    use base64::Engine;
    let src_path =
        std::fs::canonicalize(&req.src_path).map_err(|e| format!("读取拖入文件失败：{e}"))?;
    let meta = std::fs::metadata(&src_path).map_err(|e| format!("读取拖入文件信息失败：{e}"))?;
    if !meta.is_file() {
        return Err("拖入图片失败：目标不是文件".to_string());
    }
    if meta.len() > 25 * 1024 * 1024 {
        return Err("拖入图片过大（>25MB）".to_string());
    }
    let mime = match src_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        _ => return Err("仅支持拖入 png/jpg/gif/webp/bmp/avif/svg 图片文件".to_string()),
    }
    .to_string();
    let bytes = std::fs::read(&src_path).map_err(|e| format!("读取拖入文件失败：{e}"))?;
    let file_name = src_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string());
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    image_paste(
        state,
        ImagePasteRequest {
            workspace: req.workspace,
            note: req.note,
            file_name,
            mime,
            data_base64,
            upload: req.upload,
            keep_local: req.keep_local,
            endpoint: req.endpoint,
            compress: req.compress,
            quality: req.quality,
        },
    )
    .await
}

#[derive(Serialize)]
struct WebhookResult {
    ok: bool,
    status: u16,
    body_excerpt: String,
}

#[tauri::command]
async fn webhook_post(
    url: String,
    body_json: String,
    timeout_secs: Option<u64>,
) -> Result<WebhookResult, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("URL 无效：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http/https".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URL 不能包含用户名 / 密码".to_string());
    }
    reject_private_network_url(&parsed, "Webhook")?;
    if body_json.len() > 64 * 1024 {
        return Err("请求体过大（>64KB）".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&body_json)
        .map_err(|e| format!("body 不是合法 JSON：{e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs.unwrap_or(8).clamp(1, 30)))
        .redirect(safe_redirect_policy())
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;
    let resp = client
        .post(parsed)
        .header("content-type", "application/json")
        .body(body_json)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    let truncated: Vec<u8> = bytes.into_iter().take(512).collect();
    let body_excerpt = String::from_utf8_lossy(&truncated).to_string();
    Ok(WebhookResult {
        ok: (200..300).contains(&status),
        status,
        body_excerpt,
    })
}

#[tauri::command]
async fn picgo_ping(endpoint: String) -> Result<PicgoPingResult, String> {
    let upload_url = normalize_picgo_endpoint(&endpoint)?;
    let base = upload_url
        .strip_suffix("/upload")
        .unwrap_or(&upload_url)
        .to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("创建探测客户端失败：{e}"))?;
    let start = std::time::Instant::now();
    match client.get(&base).send().await {
        Ok(resp) => Ok(PicgoPingResult {
            ok: true,
            status: resp.status().as_u16(),
            latency_ms: start.elapsed().as_millis() as u64,
            message: None,
        }),
        Err(e) => Ok(PicgoPingResult {
            ok: false,
            status: 0,
            latency_ms: start.elapsed().as_millis() as u64,
            message: Some(format!("{e}")),
        }),
    }
}

fn compress_image(bytes: &[u8], mime: &str, quality: u8) -> Result<Vec<u8>, String> {
    use image::ImageFormat;
    use std::io::Cursor;
    let input_fmt = match mime {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/webp" => Some(ImageFormat::WebP),
        "image/gif" => Some(ImageFormat::Gif),
        _ => None,
    };
    let Some(fmt) = input_fmt else {
        return Err(format!("不支持压缩的 mime：{mime}"));
    };
    let img = image::load_from_memory_with_format(bytes, fmt)
        .map_err(|e| format!("图片解码失败：{e}"))?;
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    match fmt {
        ImageFormat::Jpeg => {
            let mut enc =
                image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut out), quality);
            enc.encode_image(&img)
                .map_err(|e| format!("JPEG 编码失败：{e}"))?;
        }
        ImageFormat::Png => {
            use image::codecs::png::{CompressionType, FilterType, PngEncoder};
            let enc = PngEncoder::new_with_quality(
                Cursor::new(&mut out),
                CompressionType::Best,
                FilterType::Adaptive,
            );
            img.write_with_encoder(enc)
                .map_err(|e| format!("PNG 编码失败：{e}"))?;
        }
        ImageFormat::WebP => {
            let enc = image::codecs::webp::WebPEncoder::new_lossless(Cursor::new(&mut out));
            img.write_with_encoder(enc)
                .map_err(|e| format!("WebP 编码失败：{e}"))?;
        }
        ImageFormat::Gif => {
            // gif 压缩收益小，直接透传
            out.extend_from_slice(bytes);
        }
        _ => return Err(format!("未实现的格式：{fmt:?}")),
    }
    // 如果压缩后反而更大（小图常见），返回原 bytes
    if out.len() >= bytes.len() {
        return Ok(bytes.to_vec());
    }
    Ok(out)
}

fn validate_image_payload(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_IMAGE_INPUT_BYTES {
        return Err(format!(
            "图片超过大小限制：最大 {} MB",
            MAX_IMAGE_INPUT_BYTES / 1024 / 1024
        ));
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("图片格式无法识别：{e}"))?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| format!("图片尺寸读取失败：{e}"))?;
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if pixels > MAX_IMAGE_PIXELS {
        return Err(format!(
            "图片像素过大：{}x{}，最大 {} MP",
            width,
            height,
            MAX_IMAGE_PIXELS / 1_000_000
        ));
    }
    Ok(())
}

// ─── 图片粘贴 / 上传 ────────────────────────────────────────────────

#[tauri::command]
async fn image_paste(
    state: tauri::State<'_, AppState>,
    req: ImagePasteRequest,
) -> Result<ImagePasteResult, String> {
    let ws = validate_path(&state, &req.workspace)?;
    let note = validate_path(&state, &req.note)?;
    if !note.starts_with(&ws) {
        return Err("当前文件不在所选仓库中".to_string());
    }
    let raw_base64 = req
        .data_base64
        .rsplit_once(',')
        .map(|(_, data)| data)
        .unwrap_or(req.data_base64.as_str());
    validate_body_size("剪贴板图片", raw_base64, MAX_IMAGE_INPUT_BYTES)?;
    let bytes = STANDARD
        .decode(raw_base64.trim())
        .map_err(|e| format!("剪贴板图片编码无效：{e}"))?;
    if bytes.is_empty() {
        return Err("剪贴板图片为空".to_string());
    }
    validate_image_payload(&bytes)?;

    // 可选压缩：解码 + 重编码，按 mime 选 encoder。失败则回退原始 bytes。
    let want_compress = req.compress.unwrap_or(false);
    let quality = req.quality.unwrap_or(85).clamp(1, 100);
    let mime_lower = req.mime.to_ascii_lowercase();
    let (bytes, compressed) = if want_compress {
        match compress_image(&bytes, &mime_lower, quality) {
            Ok(out) => (out, true),
            Err(e) => {
                eprintln!("[image_paste] 压缩失败，使用原始数据：{e}");
                (bytes, false)
            }
        }
    } else {
        (bytes, false)
    };

    let note_dir = note
        .parent()
        .ok_or_else(|| "当前文件没有父目录".to_string())?;
    let assets_dir = note_dir.join("Assets");
    std::fs::create_dir_all(&assets_dir).map_err(|e| format!("创建 Assets 目录失败：{e}"))?;

    let note_stem = note
        .file_stem()
        .and_then(|s| s.to_str())
        .map(sanitize_file_stem)
        .unwrap_or_else(|| "note".to_string());
    let _ = compressed;
    let ext = image_ext_from_mime(&req.mime, req.file_name.as_deref());
    let ts = chrono::Utc::now().timestamp_millis();
    let base_name = format!("{note_stem}-pasted-{ts}");
    let mut file_name = format!("{base_name}.{ext}");
    let mut target = assets_dir.join(&file_name);
    let mut idx = 2;
    while target.exists() {
        file_name = format!("{base_name}-{idx}.{ext}");
        target = assets_dir.join(&file_name);
        idx += 1;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("保存图片失败：{e}"))?;

    let local_url = format!("Assets/{file_name}");
    let local_markdown = format!("![{}]({local_url})", markdown_alt(&base_name));
    if !req.upload {
        return Ok(ImagePasteResult {
            markdown: local_markdown,
            url: local_url,
            local_path: Some(target.to_string_lossy().to_string()),
            uploaded: false,
            warning: None,
        });
    }

    let endpoint = req.endpoint.as_deref().unwrap_or("http://127.0.0.1:36677");
    match upload_with_picgo(endpoint, &target).await {
        Ok(remote_url) => {
            if !req.keep_local {
                let _ = std::fs::remove_file(&target);
            }
            Ok(ImagePasteResult {
                markdown: format!("![{}]({remote_url})", markdown_alt(&base_name)),
                url: remote_url,
                local_path: req.keep_local.then(|| target.to_string_lossy().to_string()),
                uploaded: true,
                warning: None,
            })
        }
        Err(e) => Ok(ImagePasteResult {
            markdown: local_markdown,
            url: local_url,
            local_path: Some(target.to_string_lossy().to_string()),
            uploaded: false,
            warning: Some(format!("PicGo 上传失败，已保存到本地：{e}")),
        }),
    }
}

// ─── 崩溃 / 错误日志（本地写入，不上传） ────────────────────────────

fn crash_log_dir() -> PathBuf {
    // mac: ~/Library/Logs/markio
    // win: %LOCALAPPDATA%\markio\Logs
    // linux: ~/.local/share/markio/logs
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Logs/markio");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(base).join("markio").join("Logs");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/share/markio/logs");
        }
    }
    std::env::temp_dir().join("markio-logs")
}

fn crash_log_path() -> PathBuf {
    crash_log_dir().join("markio.log")
}

fn crash_write(payload: &str) -> Result<(), String> {
    use std::io::Write;
    let bytes = payload.as_bytes();
    if bytes.len() > MAX_CRASH_PAYLOAD_BYTES {
        return Err(format!(
            "日志内容过大：最大 {} KB",
            MAX_CRASH_PAYLOAD_BYTES / 1024
        ));
    }
    let dir = crash_log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败：{e}"))?;
    let path = crash_log_path();
    if path
        .metadata()
        .map(|m| m.len() > MAX_CRASH_LOG_BYTES)
        .unwrap_or(false)
    {
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&rotated);
        let _ = std::fs::rename(&path, rotated);
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开日志失败：{e}"))?;
    f.write_all(bytes).map_err(|e| format!("写日志失败：{e}"))?;
    if !payload.ends_with('\n') {
        f.write_all(b"\n").map_err(|e| format!("写日志失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn crash_append(payload: String) -> Result<(), String> {
    crash_write(&payload)
}

#[tauri::command]
fn crash_open_dir() -> Result<(), String> {
    let dir = crash_log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败：{e}"))?;
    fs_ops::reveal_in_os(&dir.to_string_lossy())
}

#[tauri::command]
fn crash_read_latest() -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = crash_log_path();
    if !path.exists() {
        return Ok(String::new());
    }
    let mut f = std::fs::File::open(&path).map_err(|e| format!("读取日志失败：{e}"))?;
    let len = f
        .metadata()
        .map_err(|e| format!("读取日志失败：{e}"))?
        .len();
    let start = len.saturating_sub(MAX_CRASH_READ_BYTES);
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("读取日志失败：{e}"))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("读取日志失败：{e}"))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

// 自定义 CSS 主题命令已迁移到 commands::theme

fn crash_pending_path() -> PathBuf {
    crash_log_dir().join("crash-pending.json")
}

/// 用户配置 webhook 时，把崩溃摘要原子写到 pending 文件——
/// panic 上下文不能跑异步 IO，下一次启动专门做上报 + 清理。
fn write_crash_pending(payload: &str) {
    let dir = crash_log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = crash_pending_path();
    let summary = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "ts": chrono::Utc::now().to_rfc3339(),
        "payload": payload,
    });
    if let Ok(s) = serde_json::to_string(&summary) {
        let _ = std::fs::write(path, s);
    }
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "(unknown)".to_string());
        let payload = format!(
            "[{}] rust panic at {}\n{}\n\n",
            chrono::Utc::now().to_rfc3339(),
            location,
            info,
        );
        let _ = crash_write(&payload);
        write_crash_pending(&payload);
        eprintln!("{payload}");
    }));
}

// ─── macOS 系统分享（通过 osascript 走原生 app）──────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacShareInput {
    /// "mail" | "reminders"
    pub target: String,
    pub title: Option<String>,
    pub body: String,
}

/// AppleScript 字符串字面量需要转义反斜杠和双引号；换行换成 `\n`
/// 让 osascript 按字面量插入。
#[cfg(target_os = "macos")]
fn applescript_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[tauri::command]
async fn macos_share(input: MacShareInput) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = input;
        Err("系统分享仅在 macOS 可用".into())
    }
    #[cfg(target_os = "macos")]
    {
        let subject = input.title.clone().unwrap_or_default();
        let body = input.body.clone();
        let script = match input.target.as_str() {
            "mail" => format!(
                "tell application \"Mail\"\n\
                   set newMsg to make new outgoing message with properties {{subject:{subj}, content:{bod}, visible:true}}\n\
                   activate\n\
                 end tell",
                subj = applescript_quote(&subject),
                bod = applescript_quote(&body),
            ),
            "reminders" => format!(
                "tell application \"Reminders\"\n\
                   tell default list\n\
                     make new reminder with properties {{name:{name}, body:{bod}}}\n\
                   end tell\n\
                   activate\n\
                 end tell",
                name = applescript_quote(
                    if subject.is_empty() {
                        "markio note"
                    } else {
                        subject.as_str()
                    }
                ),
                bod = applescript_quote(&body),
            ),
            other => return Err(format!("未知分享目标：{other}")),
        };
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("osascript 调用失败：{e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(format!("系统分享失败：{}", err.trim()));
        }
        Ok(())
    }
}

/// 注册 / 替换全局快捷键。空字符串 = 注销全部。binding 格式与 shortcuts.ts 一致
/// （"Mod+Shift+Space"），由前端转换；这里直接传 accelerator 字符串给 plugin。
#[tauri::command]
fn set_global_shortcut(app: tauri::AppHandle, binding: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let trimmed = binding.trim();
    if trimmed.is_empty() {
        let _ = gs.unregister_all();
        return Ok(());
    }
    // 先做基本形态校验再动注册表：否则一个畸形字符串会先把已有快捷键 unregister_all
    // 清掉、随后 register 失败，导致用户彻底失去全局快捷键。
    if trimmed.len() > 100 {
        return Err("快捷键过长".to_string());
    }
    // 把 "Mod+" 翻成 plugin 接受的 "CommandOrControl+"
    let normalized = trimmed.replace("Mod+", "CommandOrControl+");
    let shape_ok = normalized
        .split('+')
        .all(|tok| !tok.is_empty() && tok.chars().all(|c| c.is_ascii_alphanumeric()));
    if !shape_ok {
        return Err("快捷键格式无效".to_string());
    }
    let _ = gs.unregister_all();
    gs.register(normalized.as_str())
        .map_err(|e| format!("注册全局快捷键失败：{e}"))
}

/// 由前端在启动后调用：若 pending 文件存在且 webhook URL 非空，
/// 异步 POST 给用户配置的接收端。成功才删除 pending，失败保留下次重试。
/// 不强制等待结果——前端 fire-and-forget。
#[tauri::command]
async fn crash_flush_to_webhook(url: String) -> Result<bool, String> {
    if url.trim().is_empty() {
        return Ok(false);
    }
    let path = crash_pending_path();
    if !path.exists() {
        return Ok(false);
    }
    let body = std::fs::read_to_string(&path).map_err(|e| format!("读取 pending 失败：{e}"))?;
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("Webhook URL 无效：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Webhook 仅支持 http/https".to_string());
    }
    reject_private_network_url(&parsed, "崩溃上报")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(safe_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(parsed)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上报失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("上报失败：HTTP {}", resp.status()));
    }
    let _ = std::fs::remove_file(&path);
    Ok(true)
}

// ─── 文档内查找（Rust 端，> 10 万字时取代 JS walkNodes） ───────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFindOptions {
    /// 默认 true，与 JS `indexOf(lower, lower)` 行为一致
    pub case_insensitive: Option<bool>,
    /// 整词匹配（按 ASCII / unicode `is_alphanumeric` 判断词边界）
    pub whole_word: Option<bool>,
    /// 正则模式；正则编译失败时返回 Err
    pub regex: Option<bool>,
    /// 上限保护，默认 5 万
    pub max_matches: Option<usize>,
}

fn text_find_scan<F>(
    text: &str,
    pattern: &str,
    options: Option<TextFindOptions>,
    mut on_match: F,
) -> Result<usize, String>
where
    F: FnMut(usize, usize),
{
    if pattern.is_empty() {
        return Ok(0);
    }
    let opts = options.unwrap_or(TextFindOptions {
        case_insensitive: Some(true),
        whole_word: None,
        regex: None,
        max_matches: None,
    });
    let ci = opts.case_insensitive.unwrap_or(true);
    let ww = opts.whole_word.unwrap_or(false);
    let cap = opts.max_matches.unwrap_or(50_000);

    let is_word_char = |c: char| c.is_alphanumeric() || c == '_';
    let has_word_boundary = |from: usize, to: usize| {
        let prev = text[..from]
            .chars()
            .next_back()
            .map(is_word_char)
            .unwrap_or(false);
        let next = text[to..].chars().next().map(is_word_char).unwrap_or(false);
        !prev && !next
    };
    let pattern = if opts.regex.unwrap_or(false) {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(ci)
        .build()
        .map_err(|e| format!("正则表达式无效：{e}"))?;
    let mut count = 0usize;

    for hit in re.find_iter(text) {
        let from = hit.start();
        let to = hit.end();
        if from == to {
            continue;
        }
        if !ww || has_word_boundary(from, to) {
            on_match(from, to);
            count += 1;
        }
        if count >= cap {
            break;
        }
    }

    Ok(count)
}

#[tauri::command]
fn text_find_ranges(
    text: String,
    pattern: String,
    options: Option<TextFindOptions>,
) -> Result<Vec<(usize, usize)>, String> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    text_find_scan(&text, &pattern, options, |from, to| out.push((from, to)))?;
    Ok(out)
}

#[tauri::command]
fn text_find_count(
    text: String,
    pattern: String,
    options: Option<TextFindOptions>,
) -> Result<usize, String> {
    text_find_scan(&text, &pattern, options, |_from, _to| {})
}

#[cfg(test)]
mod text_find_tests {
    use super::*;

    fn options(case_insensitive: bool, whole_word: bool, regex: bool) -> Option<TextFindOptions> {
        Some(TextFindOptions {
            case_insensitive: Some(case_insensitive),
            whole_word: Some(whole_word),
            regex: Some(regex),
            max_matches: None,
        })
    }

    #[test]
    fn literal_search_honors_case_sensitivity() {
        let ranges = text_find_ranges(
            "Alpha alpha ALPHA".into(),
            "alpha".into(),
            options(false, false, false),
        )
        .unwrap();

        assert_eq!(ranges, vec![(6, 11)]);
    }

    #[test]
    fn whole_word_filters_embedded_matches() {
        let ranges = text_find_ranges(
            "cat scatter cat_ cat".into(),
            "cat".into(),
            options(true, true, false),
        )
        .unwrap();

        assert_eq!(ranges, vec![(0, 3), (17, 20)]);
    }

    #[test]
    fn regex_search_returns_regex_ranges() {
        let ranges = text_find_ranges(
            "v1 v22 vx".into(),
            r"v\d+".into(),
            options(true, false, true),
        )
        .unwrap();

        assert_eq!(ranges, vec![(0, 2), (3, 6)]);
    }

    #[test]
    fn invalid_regex_returns_error() {
        let err =
            text_find_count("abc".into(), "(".into(), options(true, false, true)).unwrap_err();

        assert!(err.contains("正则表达式无效"));
    }
}

// ─── pandoc 导出（EPUB / DOCX） ────────────────────────────────────

fn common_export_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots = workspace_roots(state).unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        roots.push(home.join("Desktop"));
        roots.push(home.join("Documents"));
        roots.push(home.join("Downloads"));
    }
    roots
}

fn validate_export_dest(
    state: &AppState,
    dest_path: &str,
    format: &str,
) -> Result<PathBuf, String> {
    let dest = PathBuf::from(dest_path);
    if !dest.is_absolute() {
        return Err("导出路径必须是系统保存对话框返回的绝对路径".to_string());
    }
    if dest.file_name().is_none() {
        return Err("导出路径缺少文件名".to_string());
    }
    if dest.exists() && dest.is_dir() {
        return Err("导出目标不能是文件夹".to_string());
    }
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ext != format {
        return Err(format!("导出目标扩展名必须是 .{format}"));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| "导出路径缺少父目录".to_string())?;
    if !parent.exists() || !parent.is_dir() {
        return Err("导出目录不存在".to_string());
    }
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("导出目录无效：{e}"))?;
    if common_export_roots(state)
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| parent_canon.starts_with(root))
    {
        return Ok(dest);
    }
    Err("导出位置不在当前仓库或常用用户目录（Desktop/Documents/Downloads）中".to_string())
}

/// 把 markdown 文本通过 pandoc 转成目标格式并写到 dest_path。
/// pandoc 需要用户自己装；本命令只负责拼参数 + 收报错。
#[tauri::command]
async fn export_pandoc(
    state: tauri::State<'_, AppState>,
    source: String,
    format: String,
    dest_path: String,
) -> Result<(), String> {
    const MAX_EXPORT_SOURCE: usize = 16 * 1024 * 1024;
    let format = format.to_lowercase();
    if !["epub", "docx", "rtf", "odt"].contains(&format.as_str()) {
        return Err(format!("不支持的 pandoc 输出格式：{format}"));
    }
    if source.len() > MAX_EXPORT_SOURCE {
        return Err(format!(
            "导出源过大：{} bytes，超过 {} bytes 上限",
            source.len(),
            MAX_EXPORT_SOURCE
        ));
    }
    let dest_path = validate_export_dest(&state, &dest_path, &format)?
        .to_string_lossy()
        .to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::Write;
        // 写到临时文件，避免参数过长 / stdin 编码问题
        let mut tmp = std::env::temp_dir();
        tmp.push(format!(
            "markio-export-{}-{}.md",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        {
            let mut f =
                std::fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败：{e}"))?;
            f.write_all(source.as_bytes())
                .map_err(|e| format!("写入临时文件失败：{e}"))?;
        }
        let output = std::process::Command::new("pandoc")
            .arg(&tmp)
            .arg("-f")
            .arg("markdown")
            .arg("-t")
            .arg(&format)
            .arg("-o")
            .arg(&dest_path)
            .arg("--standalone")
            .output();
        let _ = std::fs::remove_file(&tmp);
        let output = output.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "找不到 pandoc 命令。请先安装 pandoc：https://pandoc.org/installing.html"
                    .to_string()
            } else {
                format!("调用 pandoc 失败：{e}")
            }
        })?;
        if !output.status.success() {
            return Err(format!(
                "pandoc 转换失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// 历史快照命令已迁移到 commands::history

/// 扫描 workspace 全部 md 的 frontmatter，返回每条笔记 → 字段 → 多值。
#[tauri::command]
async fn fs_scan_frontmatter(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<frontmatter::NoteFrontmatter>, String> {
    let ws = validate_path(&state, &workspace)?;
    // 整库扫描读每个 .md 抽 frontmatter，是 IO/CPU 密集活；放 spawn_blocking
    // 不冻结事件循环（PropertyExplorer 每次切仓库都会触发）。
    tokio::task::spawn_blocking(move || frontmatter::scan(&ws.to_string_lossy()))
        .await
        .map_err(|e| format!("frontmatter scan join 失败：{e}"))?
}

// MCP 状态查询 + 本地 AI Agent CLI 命令已迁移到 commands::mcp / commands::agent

// ─── 反链 ───────────────────────────────────────────────────────────

#[tauri::command]
async fn fs_backlinks(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    max: Option<usize>,
) -> Result<Vec<Backlink>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    let ws = ws.to_string_lossy().to_string();
    let f = f.to_string_lossy().to_string();
    let max = max.unwrap_or(50);
    let links = tauri::async_runtime::spawn_blocking(move || fs_ops::find_backlinks(&ws, &f, max))
        .await
        .map_err(|e| e.to_string())?;
    Ok(links)
}

#[tauri::command]
async fn fs_mentions(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    max: Option<usize>,
) -> Result<Vec<Backlink>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    let ws = ws.to_string_lossy().to_string();
    let f = f.to_string_lossy().to_string();
    let max = max.unwrap_or(50);
    let mentions =
        tauri::async_runtime::spawn_blocking(move || fs_ops::find_mentions(&ws, &f, max))
            .await
            .map_err(|e| e.to_string())?;
    Ok(mentions)
}

/// 把 file 第 line 行第一个裸出现的 needle（被链接笔记的标题）包成 `[[needle]]`。
/// 先存历史快照再原子写；返回是否真改写了。供"未链接提及 → 链接"按钮使用。
#[tauri::command]
async fn fs_link_mention(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    line: u32,
    needle: String,
) -> Result<bool, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    ensure_user_file_path(&state, &f, "改写引用")?;
    let ws = ws.to_string_lossy().to_string();
    let f = f.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        fs_ops::link_mention_in_file(&ws, &f, line, &needle)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_index_tokens(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<fs_ops::VaultTokens, String> {
    let ws = validate_path(&state, &workspace)?;
    let ws = ws.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || Ok(fs_ops::index_tokens(&ws)))
        .await
        .map_err(|e| e.to_string())?
}

/// 列出仓库 `.markio/templates/*.md` 下的自定义模板。
#[tauri::command]
async fn fs_list_user_templates(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<fs_ops::UserTemplate>, String> {
    let ws = validate_path(&state, &workspace)?;
    let ws = ws.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || Ok(fs_ops::list_user_templates(&ws)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fs_vault_index_load(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Option<fs_ops::VaultIndex>, String> {
    let ws = validate_path(&state, &workspace)?;
    let ws = ws.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || Ok(fs_ops::vault_index_load(&ws)))
        .await
        .map_err(|e| e.to_string())?
}

/// 后台扫描：若磁盘上已有 cache 则做 mtime diff，否则全量扫；扫完写回磁盘。
#[tauri::command]
async fn fs_vault_index_build(
    state: tauri::State<'_, AppState>,
    workspace: String,
    use_cache: Option<bool>,
) -> Result<fs_ops::VaultIndex, String> {
    let ws = validate_path(&state, &workspace)?;
    let ws = ws.to_string_lossy().to_string();
    let want_cache = use_cache.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let prev = if want_cache {
            fs_ops::vault_index_load(&ws)
        } else {
            None
        };
        let next = fs_ops::build_vault_index(&ws, prev.as_ref());
        if let Err(e) = fs_ops::vault_index_save(&ws, &next) {
            eprintln!("[vault_index] save failed: {e}");
        }
        Ok(next)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── 回收站 ─────────────────────────────────────────────────────────

#[tauri::command]
fn fs_trash_move(
    state: tauri::State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let p = validate_path(&state, &path)?;
    let owner = ensure_same_workspace(&state, &ws, &p)?;
    if owner != ws {
        return Err("文件不在所选仓库中".to_string());
    }
    ensure_user_file_path(&state, &p, "移到回收站")?;
    fs_ops::trash_move(&ws.to_string_lossy(), &p.to_string_lossy())?;
    state.record_close(&p)?;
    Ok(())
}

#[tauri::command]
fn fs_trash_list(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<TrashItem>, String> {
    let ws = validate_path(&state, &workspace)?;
    fs_ops::trash_list(&ws.to_string_lossy())
}

#[tauri::command]
fn fs_trash_restore(
    state: tauri::State<'_, AppState>,
    workspace: String,
    stored: String,
) -> Result<String, String> {
    let ws = validate_path(&state, &workspace)?;
    let s = validate_path(&state, &stored)?;
    let trash = ws.join(".markio").join("trash");
    if !s.starts_with(&trash) {
        return Err("回收站项目路径无效".to_string());
    }
    fs_ops::trash_restore(&ws.to_string_lossy(), &s.to_string_lossy())
}

#[tauri::command]
fn fs_trash_purge(
    state: tauri::State<'_, AppState>,
    workspace: String,
    stored: Option<String>,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let stored_p = if let Some(s) = stored {
        let p = validate_path(&state, &s)?;
        let trash = ws.join(".markio").join("trash");
        if !p.starts_with(&trash) {
            return Err("回收站项目路径无效".to_string());
        }
        Some(p.to_string_lossy().to_string())
    } else {
        None
    };
    fs_ops::trash_purge(&ws.to_string_lossy(), stored_p)
}

// 系统钥匙串命令已迁移到 commands::secret

// ─── AI ─────────────────────────────────────────────────────────────

/// 关键词检索：从仓库里抽 query 相关的片段（带上下文行），作为未建向量索引时的 grep 兜底。
/// 真正的向量 RAG 已在 commands::rag 全套实现（rag_reindex / rag_search 等），此处仅为 fallback。
#[tauri::command]
async fn ai_retrieve(
    state: tauri::State<'_, AppState>,
    workspace: String,
    query: String,
    k: Option<usize>,
) -> Result<Vec<AiContext>, String> {
    let ws = validate_path(&state, &workspace)?;
    // 全库 grep（最多读 3000 个 .md 各 2MB）；主线程跑会冻结整个事件循环。
    let ws_str = ws.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || fs_ops::retrieve_context(&ws_str, &query, k.unwrap_or(5)))
        .await
        .map_err(|e| format!("ai_retrieve join 失败：{e}"))
}

pub(crate) fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "[::1]"))
}

pub(crate) fn is_private_network_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return true;
    };
    let normalized = host
        .trim()
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if normalized.is_empty() || normalized == "localhost" || normalized.ends_with(".localhost") {
        return true;
    }
    match normalized.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let octets = ip.octets();
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

pub(crate) fn reject_private_network_url(url: &reqwest::Url, label: &str) -> Result<(), String> {
    if is_private_network_host(url.host_str()) {
        return Err(format!("{label} 不允许访问 localhost、内网或链路本地地址"));
    }
    Ok(())
}

/// 出站请求的重定向策略：每一跳都重新校验目标主机，阻止远端用 30x 跳转
/// 把 SSRF 守卫绕过到 127.0.0.1 / 169.254.169.254 / 内网地址。最多跟随 5 跳。
pub(crate) fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("重定向次数过多");
        }
        if is_private_network_host(attempt.url().host_str()) {
            return attempt.error("重定向指向内网/环回地址，已阻止");
        }
        attempt.follow()
    })
}

/// 流式读取响应体并实时限幅。避免恶意 / 不报或谎报 Content-Length 的服务器先把
/// 数 GB 整体缓冲进内存、再走事后大小检查（那时内存已被撑爆）。超限立即中止。
pub(crate) async fn read_capped(
    resp: reqwest::Response,
    max: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("{label} 读取响应失败：{e}"))?
    {
        if buf.len() + chunk.len() > max {
            return Err(format!(
                "{label} 下载内容超过上限：最大 {} MB",
                max / 1024 / 1024
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

pub(crate) fn endpoint_host(endpoint: &str) -> Result<Option<String>, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|e| format!("API endpoint 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("API endpoint 仅支持 http/https".to_string());
    }
    Ok(url.host_str().map(str::to_ascii_lowercase))
}

/// 每个 provider 允许覆盖的官方 host 白名单：自定义 endpoint 必须落在这些 host
/// 之一（或是 loopback / "custom" 任意），否则视为钓鱼地址直接拒绝。新增 provider
/// 时改这里 + src/lib/ai-providers.ts + ai.rs 的默认 endpoint 三处。
fn allowed_hosts_for(provider: &str) -> &'static [&'static str] {
    match provider {
        "anthropic" => &["api.anthropic.com"],
        "google" => &["generativelanguage.googleapis.com"],
        "openai" => &["api.openai.com"],
        "deepseek" => &["api.deepseek.com"],
        "nvidia" => &["integrate.api.nvidia.com"],
        "xai" => &["api.x.ai"],
        "groq" => &["api.groq.com"],
        "openrouter" => &["openrouter.ai"],
        "siliconflow" => &["api.siliconflow.cn"],
        "zhipu" => &["open.bigmodel.cn"],
        "dashscope" => &["dashscope.aliyuncs.com"],
        "moonshot" => &["api.moonshot.cn"],
        "mistral" => &["api.mistral.ai"],
        "together" => &["api.together.xyz"],
        "xiaomi" => &["api.xiaomimimo.com"],
        _ => &[],
    }
}

fn check_ai_endpoint_host(provider: &str, endpoint: &str) -> Result<(), String> {
    let host = endpoint_host(endpoint)?;
    let loopback = is_loopback_host(host.as_deref());
    let allowed = match provider {
        "ollama" => loopback,
        "custom" => true,
        other => {
            let list = allowed_hosts_for(other);
            list.iter().any(|h| host.as_deref() == Some(*h))
        }
    };
    if allowed {
        Ok(())
    } else {
        Err("该 provider 不允许使用非官方或非本机 endpoint".to_string())
    }
}

fn validate_ai_endpoint(req: &ChatRequest) -> Result<(), String> {
    let Some(endpoint) = req.endpoint.as_deref().filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    check_ai_endpoint_host(&req.provider, endpoint)
}

fn hydrate_api_key(req: &mut ChatRequest) {
    if req.api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        let account = format!("ai:{}", req.provider);
        if !commands::secret::is_allowed_secret_account(&account) {
            return;
        }
        if let Ok(Some(stored)) = secrets::get(&account) {
            req.api_key = Some(stored);
        }
    }
}

fn validate_ai_endpoint_agent(req: &AgentRequest) -> Result<(), String> {
    let Some(endpoint) = req.endpoint.as_deref().filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    check_ai_endpoint_host(&req.provider, endpoint)
}

fn hydrate_api_key_agent(req: &mut AgentRequest) {
    if req.api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        let account = format!("ai:{}", req.provider);
        if !commands::secret::is_allowed_secret_account(&account) {
            return;
        }
        if let Ok(Some(stored)) = secrets::get(&account) {
            req.api_key = Some(stored);
        }
    }
}

#[tauri::command]
async fn ai_chat(req: ChatRequest) -> Result<ChatResponse, String> {
    let mut req = req;
    validate_ai_endpoint(&req)?;
    hydrate_api_key(&mut req);
    ai::chat(req).await
}

#[tauri::command]
async fn ai_chat_stream(
    app: tauri::AppHandle,
    stream_id: String,
    req: ChatRequest,
) -> Result<(), String> {
    let mut req = req;
    validate_ai_endpoint(&req)?;
    hydrate_api_key(&mut req);
    tauri::async_runtime::spawn(async move {
        ai::chat_stream(app, stream_id, req).await;
    });
    Ok(())
}

#[tauri::command]
fn ai_chat_cancel(stream_id: String) -> Result<(), String> {
    ai::cancel_stream(&stream_id);
    Ok(())
}

#[tauri::command]
async fn ai_chat_with_tools(req: AgentRequest) -> Result<AgentTurnResult, String> {
    let mut req = req;
    validate_ai_endpoint_agent(&req)?;
    hydrate_api_key_agent(&mut req);
    ai::chat_with_tools(req).await
}

// rss_fetch 命令已迁移到 commands::rss

#[tauri::command]
async fn ai_list_models(
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ai::ModelInfo>, String> {
    // 走和 ai_chat 一致的安全闸门：endpoint host 必须在白名单里，否则拒绝；
    // Key 留空时再从系统钥匙串补 ai:${provider}。
    if let Some(ep) = endpoint.as_deref().filter(|s| !s.trim().is_empty()) {
        check_ai_endpoint_host(&provider, ep)?;
    }
    let mut key = api_key;
    if key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        let account = format!("ai:{}", provider);
        if commands::secret::is_allowed_secret_account(&account) {
            if let Ok(Some(stored)) = secrets::get(&account) {
                key = Some(stored);
            }
        }
    }
    ai::list_models(provider, endpoint, key).await
}

// Git 同步命令已迁移到 commands::git

// WebDAV / S3 / iCloud / Dropbox / Google Drive 命令已迁移到 commands/{webdav,s3,icloud,dropbox,gdrive}

// 第三方笔记导入命令已迁移到 commands::import

// RAG 相关命令 + DTO + 任务调度 helpers 已迁移到 commands::rag

// ─── 入口 ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    // dev 模式下再追加一层 hook（写到项目 dev-logs/），release 是 no-op
    dev_log::install_panic_hook();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(
                    |app: &tauri::AppHandle,
                     _shortcut: &tauri_plugin_global_shortcut::Shortcut,
                     event: tauri_plugin_global_shortcut::ShortcutEvent| {
                        use tauri::Manager;
                        use tauri_plugin_global_shortcut::ShortcutState;
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        // 默认行为：把主窗口拉到前台 + emit 事件给前端
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                        let _ = app.emit("global-shortcut", ());
                    },
                )
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(std::sync::Arc::new(mcp::McpRuntime::default()))
        .manage(std::sync::Arc::new(clipper::ClipperRuntime::default()))
        .manage(std::sync::Arc::new(
            smart_channel::SmartChannelRuntime::default(),
        ))
        .manage(std::sync::Arc::new(p2p::P2pRuntime::default()))
        .invoke_handler(tauri::generate_handler![
            md_render,
            md_render_stream,
            md_cancel_stream,
            md_outline,
            app_storefront_country_code,
            workspace_register,
            workspace_unregister,
            watcher_health,
            fs_read_tree,
            fs_read_dir,
            fs_read_text,
            fs_read_file_base64,
            fs_pick_file_base64,
            fs_sync_scan,
            fs_sync_read_file_base64,
            fs_sync_write_file_base64,
            fs_sync_soft_delete,
            fs_sync_manifest_read,
            fs_sync_manifest_write,
            fs_open,
            fs_close,
            fs_save,
            fs_create_new,
            fs_rename,
            fs_update_wikilinks,
            fs_delete,
            fs_mkdir,
            fs_grep,
            fs_reveal,
            fs_list_attachments,
            image_paste,
            image_paste_from_disk,
            picgo_ping,
            webhook_post,
            export_pandoc,
            export_write_file,
            export_site_write,
            fetch_image_as_data_url,
            text_find_ranges,
            text_find_count,
            crash_append,
            crash_flush_to_webhook,
            set_global_shortcut,
            macos_share,
            crash_open_dir,
            crash_read_latest,
            dev_log::dev_log_append,
            history_save,
            history_list,
            history_read,
            history_list_all,
            fs_scan_frontmatter,
            mcp_status,
            mcp_set_active_workspace,
            agent_list_providers,
            agent_run,
            agent_cancel,
            fs_backlinks,
            fs_mentions,
            fs_link_mention,
            fs_list_user_templates,
            fs_index_tokens,
            fs_vault_index_load,
            fs_vault_index_build,
            theme_list,
            theme_import,
            theme_read,
            theme_delete,
            theme_dir_path,
            fs_trash_move,
            fs_trash_list,
            fs_trash_restore,
            fs_trash_purge,
            secret_set,
            secret_get,
            secret_copy,
            secret_has,
            secret_delete,
            ai_chat,
            ai_chat_stream,
            ai_chat_cancel,
            ai_chat_with_tools,
            ai_list_models,
            rss_fetch,
            ai_retrieve,
            git_init,
            git_clone,
            git_status,
            git_fetch,
            git_commit,
            git_pull,
            git_push,
            git_list_branches,
            git_checkout,
            git_resolve_conflict,
            git_set_pat,
            git_has_pat,
            webdav_test,
            webdav_list,
            webdav_put,
            webdav_get,
            webdav_delete,
            webdav_mkcol,
            webdav_set_password,
            webdav_has_password,
            s3_put_object,
            s3_set_secret,
            s3_has_secret,
            s3_list_objects,
            s3_get_object,
            s3_delete_object,
            icloud_default_path,
            dropbox_authorize,
            dropbox_status,
            dropbox_signout,
            dropbox_list,
            dropbox_list_continue,
            dropbox_upload,
            dropbox_create_folder,
            dropbox_download,
            dropbox_delete,
            gdrive_authorize,
            gdrive_status,
            gdrive_signout,
            gdrive_list,
            gdrive_create_folder,
            gdrive_upload,
            gdrive_download,
            gdrive_delete,
            import_run,
            import_apple_notes,
            import_list_legacy_dirs,
            import_trash_legacy_dir,
            rag_status,
            rag_reindex,
            rag_embed_test,
            rag_cancel,
            rag_reindex_file,
            rag_remove_file,
            rag_search,
            rag_clear,
            rag_repo_graph,
            tray_set_visible,
            clipper_status,
            clipper_set_config,
            clipper_set_active_workspace,
            clipper_set_summary,
            smart_channel_status,
            smart_channel_set_config,
            smart_channel_respond,
            p2p_status,
            p2p_set_config,
            p2p_set_active_workspace,
            p2p_open_pairing,
            p2p_close_pairing,
            p2p_token_set,
            p2p_token_get,
            p2p_token_delete,
        ])
        .setup(|app| {
            if let Err(e) = install_tray(app.handle()) {
                eprintln!("install_tray failed: {e}");
            }
            window_state::install(app.handle());
            window_state::apply_on_startup(app.handle());
            // 启动时如果是双击文件触发的，URL 已经在 CLI args 里（macOS 例外，走下面 Opened 事件）
            forward_cli_open_files(app.handle());
            // MCP loopback HTTP server：异步启动，启动失败仅打日志。
            {
                let runtime = app
                    .handle()
                    .state::<std::sync::Arc<mcp::McpRuntime>>()
                    .inner()
                    .clone();
                mcp::spawn(app.handle().clone(), runtime);
            }
            // WebClipper / SmartChannel loopback server：同样异步启动，失败仅打日志。
            {
                let rt = app
                    .handle()
                    .state::<std::sync::Arc<clipper::ClipperRuntime>>()
                    .inner()
                    .clone();
                clipper::spawn(app.handle().clone(), rt);
            }
            {
                let rt = app
                    .handle()
                    .state::<std::sync::Arc<smart_channel::SmartChannelRuntime>>()
                    .inner()
                    .clone();
                smart_channel::spawn(app.handle().clone(), rt);
            }
            // P2P 不在此启动：仅当前端 p2p_set_config(enabled=true) 时懒启动（避免无谓监听 0.0.0.0）。
            // markio://open?path=... 深链接：注册回调，把 path 当作 open-from-os 同一事件转发
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if let Some(path) = extract_path_from_deep_link(&url) {
                            let _ = handle.emit("open-from-os", path);
                        }
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match result {
        Ok(app) => app,
        Err(e) => {
            eprintln!("error while running tauri application: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app_handle, event| {
        // `RunEvent::Opened` 只在 macOS / iOS 上由 Tauri 暴露（#[cfg(target_os = ...)] 门控）。
        // Windows / Linux 上该 variant 不存在，整段必须同样 cfg 起来才能编译。
        // 文件关联在 Windows 上走 CLI 参数 / single-instance，不经此回调。
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                let path = url
                    .to_file_path()
                    .ok()
                    .and_then(|p| p.to_str().map(|s| s.to_string()));
                if let Some(p) = path {
                    let _ = app_handle.emit("open-from-os", p);
                }
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            let _ = app_handle;
            let _ = event;
        }
    });
}

/// 允许通过文件关联 / 深链打开的扩展名白名单。深链与 CLI 共用，
/// 防止 `markio://open?path=C:/Users/x/.ssh/id_rsa` 这类任意文件被打开
/// （进而被 openPath 自动注册成工作区，扩大文件读写权限）。
fn is_openable_note_path(path: &std::path::Path) -> bool {
    if !path.is_absolute() || !path.exists() || !path.is_file() {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown" | "mdown" | "mkd" | "txt")
    )
}

/// 解析 markio://open?path=/abs/path/to/note.md
/// 支持的形式：
///   markio://open?path=...
///   markio:///abs/path（不带 host，path 作为 URL.path）
/// 校验：必须是绝对路径且为 md/markdown/txt，否则丢弃。
fn extract_path_from_deep_link(url: &url::Url) -> Option<String> {
    if url.scheme() != "markio" {
        return None;
    }
    // 形式 1: markio://open?path=...
    if url.host_str() == Some("open") || url.path().is_empty() {
        for (k, v) in url.query_pairs() {
            if k == "path" {
                let p = v.into_owned();
                if is_openable_note_path(std::path::Path::new(&p)) {
                    return Some(p);
                }
            }
        }
    }
    // 形式 2: markio:///abs/path.md
    let path_str = url.path();
    if !path_str.is_empty()
        && path_str != "/"
        && is_openable_note_path(std::path::Path::new(path_str))
    {
        return Some(path_str.to_string());
    }
    None
}

/// Windows / Linux 上文件关联是通过命令行参数传递的；macOS 走 RunEvent::Opened。
/// 第一个非 flag 参数若是已存在的 .md / .markdown 等文件，启动后转发给前端。
fn forward_cli_open_files(app: &tauri::AppHandle) {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let p = std::path::Path::new(&arg);
        if !p.exists() || !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase());
        if !matches!(
            ext.as_deref(),
            Some("md" | "markdown" | "mdown" | "mkd" | "txt")
        ) {
            continue;
        }
        if let Some(s) = p.to_str() {
            // 用 setTimeout 给前端 hydrate 留时间——这里直接 emit，前端启动后会收到
            // （Tauri event channel 在 Webview 就绪后会回放最近一次 emit）
            let _ = app.emit("open-from-os", s.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        check_ai_endpoint_host, disk_changed_since_baseline, is_private_network_host, FileSig,
    };

    fn sig(mtime_ms: i64, hash: u64) -> FileSig {
        FileSig { mtime_ms, hash }
    }

    #[test]
    fn explicit_hash_baseline_wins_over_opened_state() {
        let disk = sig(20, 0xbb);
        let opened = sig(20, 0xbb);

        let changed =
            disk_changed_since_baseline(disk, Some(opened), Some(10), Some("aa")).unwrap();

        assert!(changed.unwrap());
    }

    #[test]
    fn opened_state_is_fallback_when_caller_has_no_baseline() {
        let disk = sig(20, 0xbb);
        let opened = sig(10, 0xbb);

        let changed = disk_changed_since_baseline(disk, Some(opened), None, None).unwrap();

        assert!(!changed.unwrap());
    }

    #[test]
    fn explicit_mtime_is_used_when_hash_is_absent() {
        let disk = sig(20, 0xbb);
        let opened = sig(20, 0xbb);

        let changed = disk_changed_since_baseline(disk, Some(opened), Some(10), None).unwrap();

        assert!(changed.unwrap());
    }

    #[test]
    fn missing_baseline_is_reported_separately() {
        let disk = sig(20, 0xbb);

        let changed = disk_changed_since_baseline(disk, None, None, None).unwrap();

        assert!(changed.is_none());
    }

    #[test]
    fn private_network_hosts_are_detected() {
        assert!(is_private_network_host(Some("localhost")));
        assert!(is_private_network_host(Some("127.0.0.1")));
        assert!(is_private_network_host(Some("192.168.1.10")));
        assert!(is_private_network_host(Some("fe80::1")));
        assert!(!is_private_network_host(Some("example.com")));
    }

    #[test]
    fn xiaomi_endpoint_host_is_allowed() {
        assert!(check_ai_endpoint_host("xiaomi", "https://api.xiaomimimo.com/v1").is_ok());
        assert!(check_ai_endpoint_host("xiaomi", "https://example.com/v1").is_err());
    }
}
