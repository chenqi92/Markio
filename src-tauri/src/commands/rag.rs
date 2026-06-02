//! RAG 向量索引 + 混合检索：status / reindex / reindex_file / remove_file /
//! search / repo_graph / clear / embed_test / cancel。
//!
//! 每个 workspace 同时只允许一个写任务（reindex / clear），用 rag_jobs() 互斥；
//! cancel 触发后，搜索/读路径仍可继续。
//!
//! 实际索引 / 检索逻辑在 `crate::rag` 模块；本文件做 workspace 校验、embedding
//! endpoint 白名单、cohere rerank key 补全、任务调度与进度事件转发。

use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use serde::Deserialize;
use tauri::Emitter;

use crate::{endpoint_host, is_loopback_host, rag, secrets, validate_path, AppState};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagEmbedConfigDto {
    pub provider: String,
    pub model: String,
    pub dim: u32,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// 取 Key 时用的源 id（如 "deepseek"/"zhipu"）。embedding 协议走 openai 兼容，
    /// 但 Key 存在 ai:{keyProvider}。为空时回落到 provider。
    pub key_provider: Option<String>,
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
    // 取 Key 用的源 id：优先 keyProvider（如 deepseek/zhipu），否则回落 provider
    let key_id = dto
        .key_provider
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(&dto.provider);
    if api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        // 先看 embed:<id>，再回落 ai:<id>
        if let Ok(Some(v)) = secrets::get(&format!("embed:{}", key_id)) {
            api_key = Some(v);
        } else if let Ok(Some(v)) = secrets::get(&format!("ai:{}", key_id)) {
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
        // openai 兼容：本机 + 一组已知 AI 厂商 host（用户在源池里配置的源），控制 SSRF 面
        "openai" => loopback || is_known_embedding_host(host.as_deref()),
        _ => false,
    };
    if allowed {
        Ok(())
    } else {
        Err("Embedding endpoint 仅允许本机服务或已知 AI 厂商".to_string())
    }
}

/// 允许做 embedding 的已知 AI 厂商 host 白名单（与 src/lib/ai-providers.ts 的厂商对齐）。
fn is_known_embedding_host(host: Option<&str>) -> bool {
    let Some(h) = host else { return false };
    let h = h.to_ascii_lowercase();
    const HOSTS: &[&str] = &[
        "api.openai.com",
        "open.bigmodel.cn",
        "dashscope.aliyuncs.com",
        "api.mistral.ai",
        "api.siliconflow.cn",
        "api.together.xyz",
        "integrate.api.nvidia.com",
        "api.deepseek.com",
        "openrouter.ai",
        "api.voyageai.com",
    ];
    HOSTS.iter().any(|known| h == *known || h.ends_with(&format!(".{known}")))
}

fn rag_jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CELL: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RagJobGuard {
    workspace: String,
    cancel: Arc<AtomicBool>,
}

impl Drop for RagJobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = rag_jobs().lock() {
            jobs.remove(&self.workspace);
        }
    }
}

impl RagJobGuard {
    fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

fn begin_rag_job(workspace: &str) -> Result<RagJobGuard, String> {
    let mut jobs = rag_jobs()
        .lock()
        .map_err(|e| format!("rag job lock: {e}"))?;
    if jobs.contains_key(workspace) {
        return Err("该仓库已有 RAG 索引任务在运行".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    jobs.insert(workspace.to_string(), cancel.clone());
    Ok(RagJobGuard {
        workspace: workspace.to_string(),
        cancel,
    })
}

fn request_rag_cancel(workspace: &str) -> Result<bool, String> {
    let jobs = rag_jobs()
        .lock()
        .map_err(|e| format!("rag job lock: {e}"))?;
    let Some(cancel) = jobs.get(workspace) else {
        return Ok(false);
    };
    cancel.store(true, Ordering::Relaxed);
    Ok(true)
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
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
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

/// rag_search 在拿到 rerank 配置后补 cohere 的 api_key（钥匙串里的 rerank:cohere），
/// 走和 hydrate_api_key 一致的"key 留空时回落钥匙串"策略。
fn hydrate_rerank_api_key(
    cfg: Option<rag::rerank::RerankConfig>,
) -> Option<rag::rerank::RerankConfig> {
    let mut cfg = cfg?;
    if cfg.provider == "cohere"
        && cfg
            .api_key
            .as_ref()
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
    {
        if let Ok(Some(stored)) = secrets::get("rerank:cohere") {
            cfg.api_key = Some(stored);
        }
    }
    Some(cfg)
}

#[tauri::command]
pub async fn rag_status(
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

/// 用空 input "ping" 测一次 embedding 服务是否可达；前端在开始 reindex 前先调它，
/// 服务不可达就直接报错给用户，不要白白起一个会失败一整轮的后台任务。
#[tauri::command]
pub async fn rag_embed_test(config: rag::embed::EmbedConfig) -> Result<usize, String> {
    let result = rag::embed::embed(&config, &["ping".to_string()]).await?;
    Ok(result.dim)
}

#[tauri::command]
pub async fn rag_reindex(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    req: RagReindexRequest,
) -> Result<(), String> {
    let ws = validate_path(&state, &req.workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    let (cfg, dim) = build_embed_config(req.config)?;
    let guard = begin_rag_job(&ws_str)?;
    let cancel = guard.cancel_token();
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
        if let Err(e) = rag::index::reindex_workspace(
            handle.clone(),
            cfg,
            move || {
                emit_rag_status_for_handle(&app_for_progress, &handle_for_progress);
            },
            move || cancel.load(Ordering::Relaxed),
        ) {
            eprintln!("[rag.reindex] {e}");
            emit_rag_status_for_handle(&app, &handle);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn rag_cancel(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<bool, String> {
    let ws = validate_path(&state, &workspace)?;
    let ws_str = ws.to_string_lossy().to_string();
    let cancelled = request_rag_cancel(&ws_str)?;
    if cancelled {
        if let Some(handle) = rag::existing_handle(&ws_str) {
            if let Ok(mut db) = handle.db.lock() {
                if let Some(p) = db.progress.as_mut() {
                    p.cancel_requested = true;
                    p.last_error = Some("正在取消索引…".to_string());
                }
            }
            emit_rag_status_for_handle(&app, &handle);
        }
    }
    Ok(cancelled)
}

#[tauri::command]
pub async fn rag_reindex_file(
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
pub async fn rag_remove_file(
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
    // 与 reindex / reindex_file / clear 一样取 workspace 互斥锁，避免在写任务进行中并发改同一 DB。
    let guard = begin_rag_job(&ws_str)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
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
pub async fn rag_search(
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
    let rerank_cfg = hydrate_rerank_api_key(req.rerank);
    let hits = tokio::task::spawn_blocking(move || -> Result<Vec<rag::SearchHit>, String> {
        let handle = rag::rag_handle(&ws_str, dim)?;
        rag::search::search_with_rerank(handle, cfg, rerank_cfg, &query, limit, expand_links)
    })
    .await
    .map_err(|e| format!("join 失败：{e}"))??;
    Ok(hits)
}

#[tauri::command]
pub async fn rag_repo_graph(
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
pub async fn rag_clear(
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
