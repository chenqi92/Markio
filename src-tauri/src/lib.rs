mod ai;
mod custom_themes;
mod fs_ops;
mod git_ops;
mod import;
mod markdown;
pub mod rag;
mod s3_ops;
mod secrets;
mod state;
mod watcher;
mod webdav_ops;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use tauri::Emitter;

use ai::{ChatRequest, ChatResponse};
use fs_ops::{AiContext, Attachment, Backlink, FileEntry, GrepHit, Snapshot, TrashItem};
use markdown::{OutlineItem, RenderResult};
use state::{ensure_in_workspaces, signature_for, AppState, FileSig};

static MD_STREAM_CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn md_stream_cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    MD_STREAM_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
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
pub struct PicgoPingResult {
    pub ok: bool,
    pub status: u16,
    pub latency_ms: u64,
    pub message: Option<String>,
}

const MAX_IMAGE_INPUT_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 80_000_000;
const MAX_SYNC_BODY_BYTES: usize = 50 * 1024 * 1024;
const MAX_CRASH_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_CRASH_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_CRASH_READ_BYTES: u64 = 512 * 1024;

fn validate_path(state: &AppState, p: &str) -> Result<PathBuf, String> {
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

fn workspace_for_path(state: &AppState, target: &Path) -> Result<PathBuf, String> {
    containing_workspace(state, target)?.ok_or_else(|| "路径不在任何已注册仓库中".to_string())
}

fn is_internal_path(workspace: &Path, target: &Path) -> bool {
    target.starts_with(workspace.join(".markio"))
}

fn ensure_user_file_path(state: &AppState, target: &Path, action: &str) -> Result<(), String> {
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

fn ensure_history_path(workspace: &Path, path: &Path) -> Result<(), String> {
    let history = workspace.join(".markio").join("history");
    if path.starts_with(history) {
        Ok(())
    } else {
        Err("拒绝读取：历史快照路径无效".to_string())
    }
}

fn ensure_path_in_workspace(workspace: &Path, file: &Path, action: &str) -> Result<(), String> {
    if file.starts_with(workspace) {
        Ok(())
    } else {
        Err(format!("拒绝{action}：文件不属于所选仓库"))
    }
}

fn validate_body_size(label: &str, raw_base64: &str, max_bytes: usize) -> Result<(), String> {
    let estimate = raw_base64.trim().len().saturating_mul(3) / 4;
    if estimate > max_bytes {
        return Err(format!(
            "{label} 超过大小限制：最大 {} MB",
            max_bytes / 1024 / 1024
        ));
    }
    Ok(())
}

fn validate_http_service_url(input: &str, label: &str) -> Result<reqwest::Url, String> {
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

fn remote_account(prefix: &str, endpoint: &str) -> Result<String, String> {
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

fn validate_remote_rel_path(path: &str, allow_empty: bool) -> Result<(), String> {
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
fn md_render(
    state: tauri::State<'_, AppState>,
    source: String,
    base_path: Option<String>,
) -> RenderResult {
    let roots = workspace_roots(&state).unwrap_or_default();
    let base = base_path
        .as_deref()
        .and_then(|path| validate_path(&state, path).ok());
    markdown::render(&source, base.as_deref(), &roots)
}

#[tauri::command]
fn md_outline(source: String) -> Vec<OutlineItem> {
    markdown::outline_only(&source)
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
        let channel = format!("md-stream-{id}");
        let remove_cancel = || {
            if let Ok(mut guard) = md_stream_cancels().lock() {
                guard.remove(&id);
            }
        };
        // 按 H1 切片：以行首 `# ` 起一段；首段（导言）可能无标题
        let mut sections: Vec<String> = Vec::new();
        let mut current = String::new();
        for line in source.split_inclusive('\n') {
            if line.starts_with("# ") && !current.is_empty() {
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
        for (idx, sec) in sections.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                remove_cancel();
                return;
            }
            let r = markdown::render(sec, base.as_deref(), &roots);
            if cancel.load(Ordering::Relaxed) {
                remove_cancel();
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
        }
        if cancel.load(Ordering::Relaxed) {
            remove_cancel();
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
        remove_cancel();
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

#[tauri::command]
fn fs_close(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    state.record_close(p)
}

/// 原子保存 + 冲突检测。
/// - `expected_mtime` 是前端打开 / 上次保存时记下的 mtime
/// - `force` 表示用户主动覆盖
/// - 返回新 sig；冲突时返回 Err("CONFLICT:<current_mtime>:<current_hash>")
#[tauri::command]
fn fs_save(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
    force: Option<bool>,
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
            let baseline_mtime = expected_mtime.or(known.map(|s| s.mtime_ms));
            let changed = if let Some(known) = known {
                disk.hash != known.hash
            } else if let Some(base) = baseline_mtime {
                disk.mtime_ms != base
            } else {
                false
            };
            if changed {
                return Err(format!("CONFLICT:{}:{:x}", disk.mtime_ms, disk.hash));
            }
        }
    }
    if let Some(old) = old_content.as_ref().filter(|old| old.as_str() != content) {
        if let Some(ws) = containing_workspace(&state, &canon)? {
            if let Err(e) =
                fs_ops::save_snapshot(&ws.to_string_lossy(), &canon.to_string_lossy(), old)
            {
                eprintln!("[history.save] 保存旧版本失败：{e}");
            }
        }
    }
    fs_ops::atomic_write(&canon, &content)?;
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
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
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
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
            .filter(|&i| i <= start)
            .next_back()
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
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
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
/// 仅做基本字符校验，不做沙箱（路径来自用户）。
#[tauri::command]
async fn export_write_file(path: String, content: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("路径为空".to_string());
    }
    if path.contains('\0') {
        return Err("路径含非法字符".to_string());
    }
    if content.len() > 64 * 1024 * 1024 {
        return Err("导出内容过大（>64MB）".to_string());
    }
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败：{e}"))
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
    let bytes = std::fs::read(&req.src_path)
        .map_err(|e| format!("读取拖入文件失败：{e}"))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("拖入图片过大（>25MB）".to_string());
    }
    let mime = match std::path::Path::new(&req.src_path)
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
        _ => "application/octet-stream",
    }
    .to_string();
    let file_name = std::path::Path::new(&req.src_path)
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
    if body_json.len() > 64 * 1024 {
        return Err("请求体过大（>64KB）".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&body_json)
        .map_err(|e| format!("body 不是合法 JSON：{e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs.unwrap_or(8).clamp(1, 30)))
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

// ─── 自定义 CSS 主题 ─────────────────────────────────────────────

#[tauri::command]
fn theme_list() -> Result<Vec<custom_themes::CustomTheme>, String> {
    custom_themes::list()
}

#[tauri::command]
fn theme_import(source_path: String) -> Result<custom_themes::CustomTheme, String> {
    custom_themes::import(&source_path)
}

#[tauri::command]
fn theme_read(id: String) -> Result<String, String> {
    custom_themes::read(&id)
}

#[tauri::command]
fn theme_delete(id: String) -> Result<(), String> {
    custom_themes::delete(&id)
}

#[tauri::command]
fn theme_dir_path() -> Result<String, String> {
    custom_themes::dir_path()
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
        eprintln!("{payload}");
    }));
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

#[tauri::command]
fn text_find_ranges(
    text: String,
    pattern: String,
    options: Option<TextFindOptions>,
) -> Result<Vec<(usize, usize)>, String> {
    if pattern.is_empty() {
        return Ok(Vec::new());
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
    let bytes = text.as_bytes();

    let mut out: Vec<(usize, usize)> = Vec::new();

    if opts.regex.unwrap_or(false) {
        // 简单正则：不引入 regex crate；只支持 . * + ? \d \w \s 等基础 — 走 String::matches
        // 这里先实现普通匹配（regex=true 视作普通匹配），后续接 regex crate 时替换。
    }

    if ci {
        // 直接走 ASCII 不敏感对比的常见路径；包含非 ASCII 时降级用全文 lower 后 indexOf
        let lower_text = text.to_lowercase();
        let lower_pat = pattern.to_lowercase();
        let pat_bytes_len = lower_pat.len();
        let mut start = 0;
        while let Some(rel) = lower_text[start..].find(&lower_pat) {
            let from = start + rel;
            let to = from + pat_bytes_len;
            if ww {
                let prev = bytes
                    .get(from.wrapping_sub(1))
                    .copied()
                    .map(|b| (b as char).is_alphanumeric() || b == b'_')
                    .unwrap_or(false);
                let next = bytes
                    .get(to)
                    .copied()
                    .map(|b| is_word_char(b as char))
                    .unwrap_or(false);
                if !prev && !next {
                    out.push((from, to));
                }
            } else {
                out.push((from, to));
            }
            if out.len() >= cap {
                break;
            }
            start = to.max(from + 1);
        }
    } else {
        let pat_len = pattern.len();
        let mut start = 0;
        while let Some(rel) = text[start..].find(&pattern) {
            let from = start + rel;
            let to = from + pat_len;
            if ww {
                let prev = bytes
                    .get(from.wrapping_sub(1))
                    .copied()
                    .map(|b| is_word_char(b as char))
                    .unwrap_or(false);
                let next = bytes
                    .get(to)
                    .copied()
                    .map(|b| is_word_char(b as char))
                    .unwrap_or(false);
                if !prev && !next {
                    out.push((from, to));
                }
            } else {
                out.push((from, to));
            }
            if out.len() >= cap {
                break;
            }
            start = to.max(from + 1);
        }
    }

    Ok(out)
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

// ─── 历史快照 ───────────────────────────────────────────────────────

#[tauri::command]
fn history_save(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    ensure_path_in_workspace(&ws, &f, "保存历史")?;
    ensure_user_file_path(&state, &f, "保存历史")?;
    fs_ops::save_snapshot(&ws.to_string_lossy(), &f.to_string_lossy(), &content)
}

#[tauri::command]
fn history_list(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
) -> Result<Vec<Snapshot>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    ensure_path_in_workspace(&ws, &f, "读取历史")?;
    ensure_user_file_path(&state, &f, "读取历史")?;
    fs_ops::list_snapshots(&ws.to_string_lossy(), &f.to_string_lossy())
}

#[tauri::command]
fn history_read(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = validate_path(&state, &path)?;
    let ws = workspace_for_path(&state, &canon)?;
    ensure_history_path(&ws, &canon)?;
    fs_ops::read_snapshot(&canon.to_string_lossy())
}

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

// ─── 系统钥匙串 ─────────────────────────────────────────────────────

fn is_allowed_secret_account(account: &str) -> bool {
    matches!(
        account,
        "ai:anthropic"
            | "ai:openai"
            | "ai:deepseek"
            | "ai:ollama"
            | "ai:google"
            | "ai:custom"
            | "embed:openai"
    )
}

fn validate_secret_account(account: &str) -> Result<(), String> {
    if is_allowed_secret_account(account) {
        Ok(())
    } else {
        Err("拒绝访问该密钥账户".to_string())
    }
}

#[tauri::command]
fn secret_set(account: String, value: String) -> Result<(), String> {
    validate_secret_account(&account)?;
    secrets::set(&account, &value)
}

#[tauri::command]
fn secret_get(_account: String) -> Result<Option<String>, String> {
    Err("出于安全考虑，不允许从前端读取密钥明文".to_string())
}

#[tauri::command]
fn secret_has(account: String) -> Result<bool, String> {
    validate_secret_account(&account)?;
    Ok(secrets::has(&account))
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    validate_secret_account(&account)?;
    secrets::delete(&account)
}

// ─── AI ─────────────────────────────────────────────────────────────

/// 关键词检索：从仓库里抽 query 相关的片段（带上下文行），喂给 AI 当 RAG 占位实现。
/// 真正向量 RAG 见 docs/ARCHITECTURE.md「AI · 上下文检索」章节的演进计划。
#[tauri::command]
fn ai_retrieve(
    state: tauri::State<'_, AppState>,
    workspace: String,
    query: String,
    k: Option<usize>,
) -> Result<Vec<AiContext>, String> {
    let ws = validate_path(&state, &workspace)?;
    Ok(fs_ops::retrieve_context(
        &ws.to_string_lossy(),
        &query,
        k.unwrap_or(5),
    ))
}

fn is_loopback_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "[::1]"))
}

fn endpoint_host(endpoint: &str) -> Result<Option<String>, String> {
    let url = reqwest::Url::parse(endpoint).map_err(|e| format!("API endpoint 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("API endpoint 仅支持 http/https".to_string());
    }
    Ok(url.host_str().map(str::to_ascii_lowercase))
}

fn validate_ai_endpoint(req: &ChatRequest) -> Result<(), String> {
    let Some(endpoint) = req.endpoint.as_deref().filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    let host = endpoint_host(endpoint)?;
    let loopback = is_loopback_host(host.as_deref());
    let allowed = match req.provider.as_str() {
        "anthropic" => host.as_deref() == Some("api.anthropic.com"),
        "google" => host.as_deref() == Some("generativelanguage.googleapis.com"),
        "openai" => host.as_deref() == Some("api.openai.com"),
        "deepseek" => host.as_deref() == Some("api.deepseek.com"),
        "ollama" => loopback,
        "custom" => true,
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("该 provider 不允许使用非官方或非本机 endpoint".to_string())
    }
}

fn hydrate_api_key(req: &mut ChatRequest) {
    if req.api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        let account = format!("ai:{}", req.provider);
        if !is_allowed_secret_account(&account) {
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

// ─── Git 同步 ──────────────────────────────────────────────────────

fn resolve_git_pat(url: &str, explicit: Option<String>) -> Option<String> {
    if let Some(t) = explicit.filter(|s| !s.is_empty()) {
        return Some(t);
    }
    let account = git_ops::keychain_account_for_url(url);
    secrets::get(&account)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

fn git_remote_url(path: &std::path::Path) -> Option<String> {
    git_ops::default_remote_url(path).ok()
}

#[tauri::command]
async fn git_init(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    tauri::async_runtime::spawn_blocking(move || git_ops::init(&canon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_clone(
    state: tauri::State<'_, AppState>,
    url: String,
    dest: String,
    pat: Option<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &dest)?;
    let pat = resolve_git_pat(&url, pat);
    let url2 = url.clone();
    tauri::async_runtime::spawn_blocking(move || git_ops::clone(&url2, &canon, pat.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_status(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<git_ops::GitStatus, String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || git_ops::status(&canon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_fetch(
    state: tauri::State<'_, AppState>,
    workspace: String,
    remote: Option<String>,
    pat: Option<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    let url = git_remote_url(&canon).unwrap_or_default();
    let pat = if url.is_empty() {
        pat.filter(|s| !s.is_empty())
    } else {
        resolve_git_pat(&url, pat)
    };
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    tauri::async_runtime::spawn_blocking(move || git_ops::fetch(&canon, &remote, pat.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(
    state: tauri::State<'_, AppState>,
    workspace: String,
    message: String,
    author_name: String,
    author_email: String,
    files: Option<Vec<String>>,
) -> Result<String, String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::commit(
            &canon,
            &message,
            &author_name,
            &author_email,
            files.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_pull(
    state: tauri::State<'_, AppState>,
    workspace: String,
    remote: Option<String>,
    branch: Option<String>,
    rebase: Option<bool>,
    pat: Option<String>,
) -> Result<(u32, u32), String> {
    let canon = validate_path(&state, &workspace)?;
    let url = git_remote_url(&canon).unwrap_or_default();
    let pat = if url.is_empty() {
        pat.filter(|s| !s.is_empty())
    } else {
        resolve_git_pat(&url, pat)
    };
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    let rebase = rebase.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::pull(&canon, &remote, branch.as_deref(), pat.as_deref(), rebase)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_push(
    state: tauri::State<'_, AppState>,
    workspace: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: Option<bool>,
    pat: Option<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    let url = git_remote_url(&canon).unwrap_or_default();
    let pat = if url.is_empty() {
        pat.filter(|s| !s.is_empty())
    } else {
        resolve_git_pat(&url, pat)
    };
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    let set_upstream = set_upstream.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::push(
            &canon,
            &remote,
            branch.as_deref(),
            pat.as_deref(),
            set_upstream,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_list_branches(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<git_ops::GitBranches, String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || git_ops::list_branches(&canon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_checkout(
    state: tauri::State<'_, AppState>,
    workspace: String,
    branch: String,
    create: Option<bool>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    let create = create.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || git_ops::checkout(&canon, &branch, create))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_resolve_conflict(
    state: tauri::State<'_, AppState>,
    workspace: String,
    strategy: String,
    files: Vec<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::resolve_conflict(&canon, &strategy, &files)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把 PAT 存到 OS 钥匙串。account 由 URL 推导（`git:<host>`），前端无需关心。
#[tauri::command]
fn git_set_pat(url: String, pat: String) -> Result<(), String> {
    let account = git_ops::keychain_account_for_url(&url);
    if pat.is_empty() {
        secrets::delete(&account)
    } else {
        secrets::set(&account, &pat)
    }
}

#[tauri::command]
fn git_has_pat(url: String) -> Result<bool, String> {
    let account = git_ops::keychain_account_for_url(&url);
    Ok(secrets::has(&account))
}

// ─── WebDAV 同步 ───────────────────────────────────────────────────

fn webdav_keychain_account(base_url: &str) -> Result<String, String> {
    remote_account("webdav", base_url)
}

fn resolve_webdav_password(base_url: &str, explicit: &str) -> Result<String, String> {
    if !explicit.is_empty() {
        return Ok(explicit.to_string());
    }
    let account = webdav_keychain_account(base_url)?;
    Ok(secrets::get(&account).ok().flatten().unwrap_or_default())
}

#[tauri::command]
async fn webdav_test(base_url: String, auth: webdav_ops::WebDavAuth) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::test(&base_url, &auth).await
}

#[tauri::command]
async fn webdav_list(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    path: String,
) -> Result<Vec<webdav_ops::WebDavEntry>, String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&path, true)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::list(&base_url, &auth, &path).await
}

#[tauri::command]
async fn webdav_put(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
    body_base64: String,
) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    validate_body_size("WebDAV 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    webdav_ops::put(&base_url, &auth, &rel_path, bytes).await
}

#[tauri::command]
async fn webdav_get(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
) -> Result<String, String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    let bytes = webdav_ops::get(&base_url, &auth, &rel_path).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
async fn webdav_delete(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::delete(&base_url, &auth, &rel_path).await
}

#[tauri::command]
async fn webdav_mkcol(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::mkcol(&base_url, &auth, &rel_path).await
}

#[tauri::command]
fn webdav_set_password(base_url: String, password: String) -> Result<(), String> {
    let account = webdav_keychain_account(&base_url)?;
    if password.is_empty() {
        secrets::delete(&account)
    } else {
        secrets::set(&account, &password)
    }
}

#[tauri::command]
fn webdav_has_password(base_url: String) -> Result<bool, String> {
    let account = webdav_keychain_account(&base_url)?;
    Ok(secrets::has(&account))
}

// ─── S3 兼容上传 ───────────────────────────────────────────────────

fn resolve_s3_secret_key(endpoint: &str, explicit: &str) -> String {
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let account = remote_account("s3", endpoint).unwrap_or_else(|_| "s3:invalid".to_string());
    secrets::get(&account).ok().flatten().unwrap_or_default()
}

#[tauri::command]
async fn s3_put_object(
    cfg: s3_ops::S3Config,
    key: String,
    body_base64: String,
    content_type: String,
) -> Result<String, String> {
    validate_http_service_url(&cfg.endpoint, "S3 endpoint")?;
    if let Some(public) = cfg
        .public_base_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        validate_http_service_url(public, "S3 public URL")?;
    }
    validate_remote_rel_path(&key, false)?;
    validate_body_size("S3 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let mut cfg = cfg;
    cfg.secret_access_key = resolve_s3_secret_key(&cfg.endpoint, &cfg.secret_access_key);
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    s3_ops::put_object(&cfg, &key, bytes, &content_type).await
}

#[tauri::command]
fn s3_set_secret(endpoint: String, secret_access_key: String) -> Result<(), String> {
    let account = remote_account("s3", &endpoint)?;
    if secret_access_key.is_empty() {
        secrets::delete(&account)
    } else {
        secrets::set(&account, &secret_access_key)
    }
}

#[tauri::command]
fn s3_has_secret(endpoint: String) -> Result<bool, String> {
    let account = remote_account("s3", &endpoint)?;
    Ok(secrets::has(&account))
}

// ─── 第三方笔记导入 ─────────────────────────────────────────────────

#[tauri::command]
async fn import_run(
    state: tauri::State<'_, AppState>,
    provider: String,
    source: String,
    workspace: String,
) -> Result<import::ImportReport, String> {
    let ws = validate_path(&state, &workspace)?;
    let src = std::path::PathBuf::from(&source);
    if !src.exists() {
        return Err(format!("源路径不存在：{source}"));
    }
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "notion" => import::import_notion(&src, &ws),
        "obsidian" => import::import_obsidian(&src, &ws),
        "bear" => import::import_bear(&src, &ws),
        "evernote" => import::import_evernote(&src, &ws),
        other => Err(format!("未知导入器：{other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── RAG 向量索引 / 混合检索 ────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagEmbedConfigDto {
    pub provider: String,
    pub model: String,
    pub dim: u32,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagReindexRequest {
    pub workspace: String,
    pub config: RagEmbedConfigDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagReindexFileRequest {
    pub workspace: String,
    pub path: String,
    pub config: RagEmbedConfigDto,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchRequest {
    pub workspace: String,
    pub query: String,
    pub limit: Option<usize>,
    pub expand_links: Option<bool>,
    pub config: RagEmbedConfigDto,
    pub rerank: Option<rag::rerank::RerankConfig>,
}

fn build_embed_config(dto: RagEmbedConfigDto) -> Result<(rag::embed::EmbedConfig, usize), String> {
    let dim = dto.dim.max(1) as usize;
    let provider = rag::embed::Provider::parse(&dto.provider)
        .ok_or_else(|| format!("未知 embedding provider：{}", dto.provider))?;
    let mut api_key = dto.api_key;
    validate_rag_endpoint(&dto.provider, dto.base_url.as_deref())?;
    if api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        // 先看 embed:<provider>，再回落 ai:<provider>
        if let Ok(Some(v)) = secrets::get(&format!("embed:{}", dto.provider)) {
            api_key = Some(v);
        } else if let Ok(Some(v)) = secrets::get(&format!("ai:{}", dto.provider)) {
            api_key = Some(v);
        }
    }
    Ok((
        rag::embed::EmbedConfig {
            provider,
            model: dto.model,
            base_url: dto.base_url,
            api_key,
        },
        dim,
    ))
}

fn validate_rag_endpoint(provider: &str, base_url: Option<&str>) -> Result<(), String> {
    let Some(endpoint) = base_url.filter(|s| !s.trim().is_empty()) else {
        return Ok(());
    };
    let host = endpoint_host(endpoint)?;
    let loopback = is_loopback_host(host.as_deref());
    let allowed = match provider {
        "ollama" => loopback,
        "openai" => loopback || host.as_deref() == Some("api.openai.com"),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("Embedding endpoint 仅允许官方 OpenAI 或本机服务".to_string())
    }
}

fn rag_jobs() -> &'static Mutex<HashSet<String>> {
    static CELL: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashSet::new()))
}

struct RagJobGuard {
    workspace: String,
}

impl Drop for RagJobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = rag_jobs().lock() {
            jobs.remove(&self.workspace);
        }
    }
}

fn begin_rag_job(workspace: &str) -> Result<RagJobGuard, String> {
    let mut jobs = rag_jobs()
        .lock()
        .map_err(|e| format!("rag job lock: {e}"))?;
    if !jobs.insert(workspace.to_string()) {
        return Err("该仓库已有 RAG 索引任务在运行".to_string());
    }
    Ok(RagJobGuard {
        workspace: workspace.to_string(),
    })
}

fn empty_rag_status(workspace: &str) -> rag::IndexStatus {
    rag::IndexStatus {
        workspace: workspace.to_string(),
        total_docs: 0,
        total_chunks: 0,
        indexed_at: None,
        embedding_model: None,
        embedding_provider: None,
        embedding_dim: None,
        db_size: 0,
        progress: None,
    }
}

fn rag_status_from_handle(handle: &Arc<rag::RagHandle>) -> Result<rag::IndexStatus, String> {
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let total_docs = db.doc_count();
    let total_chunks = db.chunk_count();
    let indexed_at = db.last_indexed_at();
    let model = db.get_meta("embedding_model");
    let provider = db.get_meta("embedding_provider");
    let dim = db.get_meta("embedding_dim").and_then(|v| v.parse().ok());
    let progress = db.progress.clone();
    Ok(rag::IndexStatus {
        workspace: handle.workspace.clone(),
        total_docs,
        total_chunks,
        indexed_at,
        embedding_model: model,
        embedding_provider: provider,
        embedding_dim: dim,
        db_size: rag::db::db_size(Path::new(&handle.workspace)),
        progress,
    })
}

fn emit_rag_status(app: &tauri::AppHandle, status: rag::IndexStatus) {
    let _ = app.emit("rag-status", status);
}

fn emit_rag_status_for_handle(app: &tauri::AppHandle, handle: &Arc<rag::RagHandle>) {
    if let Ok(status) = rag_status_from_handle(handle) {
        emit_rag_status(app, status);
    }
}

fn has_rag_full_scan(workspace: &Path) -> bool {
    let path = rag::db::db_path(workspace);
    if !path.exists() {
        return false;
    }
    let Ok(conn) = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) else {
        return false;
    };
    conn.query_row(
        "SELECT v FROM schema_meta WHERE k='last_full_scan'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.parse::<i64>().ok())
    .is_some()
}

#[tauri::command]
async fn rag_status(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<rag::IndexStatus, String> {
    let ws = validate_path(&state, &workspace)?;
    if !rag::db::db_path(&ws).exists() {
        return Ok(empty_rag_status(ws.to_string_lossy().as_ref()));
    }
    let ws_str = ws.to_string_lossy().to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<rag::IndexStatus, String> {
        let stored_dim = peek_embed_dim(Path::new(&ws_str)).unwrap_or(768);
        let handle = rag::rag_handle(&ws_str, stored_dim)?;
        rag_status_from_handle(&handle)
    })
    .await
    .map_err(|e| format!("rag_status join 失败：{e}"))?;
    result
}

fn peek_embed_dim(workspace: &Path) -> Option<usize> {
    let path = rag::db::db_path(workspace);
    if !path.exists() {
        return None;
    }
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    conn.query_row(
        "SELECT v FROM schema_meta WHERE k='embedding_dim'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()?
    .parse()
    .ok()
}

#[tauri::command]
async fn rag_reindex(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    req: RagReindexRequest,
) -> Result<(), String> {
    let ws = validate_path(&state, &req.workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    let guard = begin_rag_job(&ws_str)?;
    // 异步触发，不阻塞 IPC 调用方；进度通过 rag-status 事件推送。
    std::thread::spawn(move || {
        let _guard = guard;
        let handle = match rag::rag_handle(&ws_str, dim) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[rag.reindex] handle 打开失败：{e}");
                return;
            }
        };
        let app_for_progress = app.clone();
        let handle_for_progress = handle.clone();
        if let Err(e) = rag::index::reindex_workspace(handle.clone(), cfg, move || {
            emit_rag_status_for_handle(&app_for_progress, &handle_for_progress);
        }) {
            eprintln!("[rag.reindex] {e}");
            emit_rag_status_for_handle(&app, &handle);
        }
    });
    Ok(())
}

#[tauri::command]
async fn rag_reindex_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    req: RagReindexFileRequest,
) -> Result<(), String> {
    let ws = validate_path(&state, &req.workspace)?;
    let path = validate_path(&state, &req.path)?;
    if !path.starts_with(&ws) {
        return Err("文件不在所选仓库中".to_string());
    }
    if !has_rag_full_scan(&ws) {
        return Ok(());
    }
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    let guard = begin_rag_job(&ws_str)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::index::reindex_file(handle.clone(), cfg, &path)?;
        emit_rag_status_for_handle(&app, &handle);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(())
}

#[tauri::command]
async fn rag_remove_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let p = validate_path(&state, &path)?;
    if !has_rag_full_scan(&ws) {
        return Ok(());
    }
    let ws_str = ws.to_string_lossy().to_string();
    let dim = peek_embed_dim(&ws).unwrap_or(768);
    tokio::task::spawn_blocking(move || {
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::index::remove_file(handle.clone(), &p)?;
        emit_rag_status_for_handle(&app, &handle);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(())
}

#[tauri::command]
async fn rag_search(
    state: tauri::State<'_, AppState>,
    req: RagSearchRequest,
) -> Result<Vec<rag::SearchHit>, String> {
    let ws = validate_path(&state, &req.workspace)?;
    if !has_rag_full_scan(&ws) {
        return Ok(Vec::new());
    }
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    let query = req.query;
    let limit = req.limit.unwrap_or(8);
    let expand_links = req.expand_links.unwrap_or(true);
    let rerank_cfg = req.rerank;
    let hits = tokio::task::spawn_blocking(move || -> Result<Vec<rag::SearchHit>, String> {
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::search::search_with_rerank(handle, cfg, rerank_cfg, &query, limit, expand_links)
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(hits)
}

#[tauri::command]
async fn rag_repo_graph(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<rag::graph::RepoGraph, String> {
    let ws = validate_path(&state, &workspace)?;
    if !has_rag_full_scan(&ws) {
        return Ok(rag::graph::RepoGraph {
            nodes: Vec::new(),
            edges: Vec::new(),
        });
    }
    let ws_str = ws.to_string_lossy().to_string();
    let dim = peek_embed_dim(&ws).unwrap_or(768);
    tokio::task::spawn_blocking(move || -> Result<rag::graph::RepoGraph, String> {
        let handle = rag::rag_handle(&ws_str, dim)?;
        let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
        rag::graph::repo_graph(&db)
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))?
}

#[tauri::command]
async fn rag_clear(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    let guard = begin_rag_job(&ws_str)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _guard = guard;
        rag::drop_handle(&ws_str);
        let path = rag::db::db_path(Path::new(&ws_str));
        // 包括 WAL/-shm 一并清掉
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        emit_rag_status(&app, empty_rag_status(&ws_str));
        Ok(())
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(())
}

// ─── 入口 ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            md_render,
            md_render_stream,
            md_cancel_stream,
            md_outline,
            workspace_register,
            workspace_unregister,
            fs_read_tree,
            fs_read_dir,
            fs_open,
            fs_close,
            fs_save,
            fs_create_new,
            fs_rename,
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
            fetch_image_as_data_url,
            text_find_ranges,
            crash_append,
            crash_open_dir,
            crash_read_latest,
            history_save,
            history_list,
            history_read,
            fs_backlinks,
            fs_mentions,
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
            secret_has,
            secret_delete,
            ai_chat,
            ai_chat_stream,
            ai_chat_cancel,
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
            import_run,
            rag_status,
            rag_reindex,
            rag_reindex_file,
            rag_remove_file,
            rag_search,
            rag_clear,
            rag_repo_graph,
            tray_set_visible,
        ])
        .setup(|app| {
            if let Err(e) = install_tray(&app.handle()) {
                eprintln!("install_tray failed: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
