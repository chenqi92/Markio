mod ai;
mod fs_ops;
mod markdown;
mod rag;
mod secrets;
mod state;

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use ai::{ChatRequest, ChatResponse};
use fs_ops::{AiContext, Attachment, Backlink, FileEntry, GrepHit, Snapshot, TrashItem};
use markdown::{OutlineItem, RenderResult};
use state::{ensure_in_workspaces, signature_for, AppState, FileSig};

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

// ─── workspace 注册 ─────────────────────────────────────────────────

#[tauri::command]
fn workspace_register(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = state.register_workspace(Path::new(&path))?;
    Ok(canon.to_string_lossy().to_string())
}

#[tauri::command]
fn workspace_unregister(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    state.unregister_workspace(Path::new(&path))
}

// ─── 树 & 文件 ──────────────────────────────────────────────────────

#[tauri::command]
fn fs_read_tree(state: tauri::State<'_, AppState>, path: String) -> Result<FileEntry, String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::walk_tree(&canon.to_string_lossy())
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
    let forced = force.unwrap_or(false);
    if !forced {
        // 检查磁盘上是否被改过
        if canon.exists() {
            let disk = signature_for(&canon).map_err(|e| e.to_string())?;
            let known = state.last_sig(&canon);
            let baseline_mtime = expected_mtime.or(known.map(|s| s.mtime_ms));
            if let Some(base) = baseline_mtime {
                if disk.mtime_ms > base {
                    return Err(format!("CONFLICT:{}:{:x}", disk.mtime_ms, disk.hash));
                }
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
    fs_ops::create_new(&canon, &content)?;
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(sig.into())
}

#[tauri::command]
fn fs_rename(state: tauri::State<'_, AppState>, from: String, to: String) -> Result<(), String> {
    let from_p = validate_path(&state, &from)?;
    let to_p = validate_path(&state, &to)?;
    fs_ops::rename(&from_p.to_string_lossy(), &to_p.to_string_lossy())?;
    state.record_close(&from_p)?;
    Ok(())
}

#[tauri::command]
fn fs_delete(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::delete(&canon.to_string_lossy())?;
    state.record_close(&canon)?;
    Ok(())
}

#[tauri::command]
fn fs_mkdir(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::make_dir(&canon.to_string_lossy())
}

#[tauri::command]
fn fs_grep(
    state: tauri::State<'_, AppState>,
    root: String,
    query: String,
    max: Option<usize>,
) -> Result<Vec<GrepHit>, String> {
    let canon = validate_path(&state, &root)?;
    Ok(fs_ops::grep(
        &canon.to_string_lossy(),
        &query,
        max.unwrap_or(80),
    ))
}

#[tauri::command]
fn fs_reveal(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::reveal_in_os(&canon.to_string_lossy())
}

#[tauri::command]
fn fs_list_attachments(
    state: tauri::State<'_, AppState>,
    workspace: String,
    max: Option<usize>,
) -> Result<Vec<Attachment>, String> {
    let canon = validate_path(&state, &workspace)?;
    Ok(fs_ops::list_attachments(
        &canon.to_string_lossy(),
        max.unwrap_or(200),
    ))
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
        } else if ch == '-' || ch == '_' || ch.is_whitespace() {
            if !last_dash && !out.is_empty() {
                out.push('-');
                last_dash = true;
            }
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
    let bytes = STANDARD
        .decode(raw_base64.trim())
        .map_err(|e| format!("剪贴板图片编码无效：{e}"))?;
    if bytes.is_empty() {
        return Err("剪贴板图片为空".to_string());
    }

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
    fs_ops::list_snapshots(&ws.to_string_lossy(), &f.to_string_lossy())
}

#[tauri::command]
fn history_read(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::read_snapshot(&canon.to_string_lossy())
}

// ─── 反链 ───────────────────────────────────────────────────────────

#[tauri::command]
fn fs_backlinks(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    max: Option<usize>,
) -> Result<Vec<Backlink>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    Ok(fs_ops::find_backlinks(
        &ws.to_string_lossy(),
        &f.to_string_lossy(),
        max.unwrap_or(50),
    ))
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
        Some(validate_path(&state, &s)?.to_string_lossy().to_string())
    } else {
        None
    };
    fs_ops::trash_purge(&ws.to_string_lossy(), stored_p)
}

// ─── 系统钥匙串 ─────────────────────────────────────────────────────

#[tauri::command]
fn secret_set(account: String, value: String) -> Result<(), String> {
    secrets::set(&account, &value)
}

#[tauri::command]
fn secret_get(account: String) -> Result<Option<String>, String> {
    secrets::get(&account)
}

#[tauri::command]
fn secret_has(account: String) -> Result<bool, String> {
    Ok(secrets::has(&account))
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
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

#[tauri::command]
async fn ai_chat(req: ChatRequest) -> Result<ChatResponse, String> {
    // 如果前端没传 key，从钥匙串读
    let mut req = req;
    if req.api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        let account = format!("ai:{}", req.provider);
        if let Ok(Some(stored)) = secrets::get(&account) {
            req.api_key = Some(stored);
        }
    }
    ai::chat(req).await
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
}

fn build_embed_config(
    dto: RagEmbedConfigDto,
) -> Result<(rag::embed::EmbedConfig, usize), String> {
    let dim = dto.dim.max(1) as usize;
    let provider = rag::embed::Provider::parse(&dto.provider)
        .ok_or_else(|| format!("未知 embedding provider：{}", dto.provider))?;
    let mut api_key = dto.api_key;
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

#[tauri::command]
async fn rag_status(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<rag::IndexStatus, String> {
    let ws = validate_path(&state, &workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<rag::IndexStatus, String> {
        let stored_dim = peek_embed_dim(Path::new(&ws_str)).unwrap_or(768);
        let handle = rag::rag_handle(&ws_str, stored_dim)?;
        let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
        let total_docs = db.doc_count();
        let total_chunks = db.chunk_count();
        let indexed_at = db.last_indexed_at();
        let model = db.get_meta("embedding_model");
        let provider = db.get_meta("embedding_provider");
        let dim = db.get_meta("embedding_dim").and_then(|v| v.parse().ok());
        let progress = db.progress.clone();
        Ok(rag::IndexStatus {
            workspace: ws_str.clone(),
            total_docs,
            total_chunks,
            indexed_at,
            embedding_model: model,
            embedding_provider: provider,
            embedding_dim: dim,
            db_size: rag::db::db_size(Path::new(&ws_str)),
            progress,
        })
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
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
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
    state: tauri::State<'_, AppState>,
    req: RagReindexRequest,
) -> Result<(), String> {
    let ws = validate_path(&state, &req.workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    // 异步触发，不阻塞 IPC 调用方；前端再 poll rag_status
    std::thread::spawn(move || {
        let handle = match rag::rag_handle(&ws_str, dim) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[rag.reindex] handle 打开失败：{e}");
                return;
            }
        };
        if let Err(e) = rag::index::reindex_workspace(handle, cfg) {
            eprintln!("[rag.reindex] {e}");
        }
    });
    Ok(())
}

#[tauri::command]
async fn rag_reindex_file(
    state: tauri::State<'_, AppState>,
    req: RagReindexFileRequest,
) -> Result<(), String> {
    let ws = validate_path(&state, &req.workspace)?;
    let path = validate_path(&state, &req.path)?;
    if !path.starts_with(&ws) {
        return Err("文件不在所选仓库中".to_string());
    }
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    tokio::task::spawn_blocking(move || {
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::index::reindex_file(handle, cfg, &path)?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(())
}

#[tauri::command]
async fn rag_remove_file(
    state: tauri::State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let p = validate_path(&state, &path)?;
    let ws_str = ws.to_string_lossy().to_string();
    let dim = peek_embed_dim(&ws).unwrap_or(768);
    tokio::task::spawn_blocking(move || {
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::index::remove_file(handle, &p)?;
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
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    let query = req.query;
    let limit = req.limit.unwrap_or(8);
    let expand_links = req.expand_links.unwrap_or(true);
    let hits = tokio::task::spawn_blocking(move || -> Result<Vec<rag::SearchHit>, String> {
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::search::search(handle, cfg, &query, limit, expand_links)
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(hits)
}

#[tauri::command]
async fn rag_clear(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        rag::drop_handle(&ws_str);
        let path = rag::db::db_path(Path::new(&ws_str));
        // 包括 WAL/-shm 一并清掉
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        Ok(())
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(())
}


// ─── 入口 ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            md_render,
            md_outline,
            workspace_register,
            workspace_unregister,
            fs_read_tree,
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
            history_save,
            history_list,
            history_read,
            fs_backlinks,
            fs_trash_move,
            fs_trash_list,
            fs_trash_restore,
            fs_trash_purge,
            secret_set,
            secret_get,
            secret_has,
            secret_delete,
            ai_chat,
            ai_retrieve,
            rag_status,
            rag_reindex,
            rag_reindex_file,
            rag_remove_file,
            rag_search,
            rag_clear,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
