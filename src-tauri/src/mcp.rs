//! MCP loopback HTTP server。
//!
//! 给独立的 `mcp-server/` (Node) 包做 RPC 转发层。外部 AI 工具（Claude Code /
//! Codex / 其它）通过 stdio 跟 Node 包说话；Node 包通过 HTTP 找 markio。
//!
//! 安全模型：
//! - 只 bind 127.0.0.1（loopback），不开外网
//! - 鉴权头 `Authorization: Bearer <token>`，token 在 markio 启动时随机生成
//! - 所有路径都过 fs_ops 已有的 workspace allowlist 校验

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;

use crate::fs_ops::{self, GrepHit};
use crate::state::AppState;

/// 全局可见的 MCP 端口 / token / active workspace（前端可读可写）。
#[derive(Default)]
pub struct McpRuntime {
    inner: RwLock<McpRuntimeInner>,
}

#[derive(Default, Clone)]
struct McpRuntimeInner {
    port: Option<u16>,
    token: Option<String>,
    /// 没有指定 workspace 时用这个。前端切 vault 后会更新。
    active_workspace: Option<PathBuf>,
}

impl McpRuntime {
    pub fn snapshot(&self) -> (Option<u16>, Option<String>, Option<PathBuf>) {
        let g = self.inner.read().unwrap();
        (g.port, g.token.clone(), g.active_workspace.clone())
    }

    pub fn set_active_workspace(&self, p: Option<PathBuf>) {
        self.inner.write().unwrap().active_workspace = p;
    }

    fn set_started(&self, port: u16, token: String) {
        let mut g = self.inner.write().unwrap();
        g.port = Some(port);
        g.token = Some(token);
    }
}

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    runtime: Arc<McpRuntime>,
}

fn random_token() -> String {
    // 32 字节随机 → hex。getrandom 已经是 markio 依赖。
    let mut buf = [0u8; 32];
    if getrandom::getrandom(&mut buf).is_err() {
        // 极少出现；fallback 用时间戳，仅为了不 panic
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        return format!("{now:032x}");
    }
    hex::encode(buf)
}

/// 在后台启动 MCP server。失败不会让 app crash，但会打日志。
pub fn spawn(app: AppHandle, runtime: Arc<McpRuntime>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app, runtime).await {
            eprintln!("[mcp] server 启动失败：{e}");
        }
    });
}

async fn run(app: AppHandle, runtime: Arc<McpRuntime>) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = random_token();
    runtime.set_started(port, token.clone());

    let state = ServerState {
        app,
        runtime: runtime.clone(),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/vaults", get(list_vaults))
        .route("/rpc/search", post(rpc_search))
        .route("/rpc/get_note", post(rpc_get_note))
        .route("/rpc/list_notes", post(rpc_list_notes))
        .route("/rpc/open_note", post(rpc_open_note))
        .route("/rpc/get_vault_info", post(rpc_get_vault_info))
        .with_state(state);

    eprintln!("[mcp] listening on http://127.0.0.1:{port}");
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("axum serve: {e}"))
}

// ────────────────────────────── auth ──────────────────────────────

fn check_token(headers: &HeaderMap, expected: &Option<String>) -> Result<(), (StatusCode, String)> {
    let Some(want) = expected else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "MCP 尚未就绪".into()));
    };
    let got = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if got != want {
        return Err((StatusCode::UNAUTHORIZED, "无效 token".into()));
    }
    Ok(())
}

// ────────────────────────────── handlers ──────────────────────────────

async fn health() -> Json<HashMap<&'static str, &'static str>> {
    let mut m = HashMap::new();
    m.insert("status", "ok");
    Json(m)
}

#[derive(Serialize)]
struct VaultInfo {
    path: String,
    name: String,
}

async fn list_vaults(
    State(s): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<Vec<VaultInfo>>, (StatusCode, String)> {
    let (_, token, _) = s.runtime.snapshot();
    check_token(&headers, &token)?;
    let app_state = s.app.state::<AppState>();
    let inner = app_state
        .inner
        .lock()
        .map_err(|e| internal(e.to_string()))?;
    let mut out: Vec<VaultInfo> = inner
        .workspaces
        .iter()
        .map(|p| VaultInfo {
            path: p.to_string_lossy().to_string(),
            name: p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(out))
}

#[derive(Deserialize)]
struct SearchReq {
    query: String,
    workspace: Option<String>,
    limit: Option<usize>,
}

async fn rpc_search(
    State(s): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<SearchReq>,
) -> Result<Json<Vec<GrepHit>>, (StatusCode, String)> {
    let (_, token, active) = s.runtime.snapshot();
    check_token(&headers, &token)?;
    let ws = resolve_workspace(&s.app, req.workspace.as_deref(), active.as_deref())?;
    let limit = req.limit.unwrap_or(50).min(200);
    let q = req.query.clone();
    let root = ws.to_string_lossy().to_string();
    let hits = tauri::async_runtime::spawn_blocking(move || fs_ops::grep(&root, &q, limit))
        .await
        .map_err(|e| internal(e.to_string()))?;
    Ok(Json(hits))
}

#[derive(Deserialize)]
struct GetNoteReq {
    path: String,
}

#[derive(Serialize)]
struct NoteResp {
    path: String,
    content: String,
}

async fn rpc_get_note(
    State(s): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<GetNoteReq>,
) -> Result<Json<NoteResp>, (StatusCode, String)> {
    let (_, token, _) = s.runtime.snapshot();
    check_token(&headers, &token)?;
    let path = ensure_in_any_workspace(&s.app, &req.path)?;
    let content =
        fs_ops::read_text(&path.to_string_lossy()).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    Ok(Json(NoteResp {
        path: path.to_string_lossy().to_string(),
        content,
    }))
}

#[derive(Deserialize, Default)]
struct ListNotesReq {
    workspace: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct NoteSummary {
    path: String,
    name: String,
    size: u64,
}

async fn rpc_list_notes(
    State(s): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<ListNotesReq>,
) -> Result<Json<Vec<NoteSummary>>, (StatusCode, String)> {
    let (_, token, active) = s.runtime.snapshot();
    check_token(&headers, &token)?;
    let ws = resolve_workspace(&s.app, req.workspace.as_deref(), active.as_deref())?;
    let limit = req.limit.unwrap_or(500).min(5000);
    let root = ws.clone();
    let notes = tauri::async_runtime::spawn_blocking(move || collect_notes(&root, limit))
        .await
        .map_err(|e| internal(e.to_string()))?;
    Ok(Json(notes))
}

#[derive(Deserialize)]
struct OpenNoteReq {
    path: String,
}

async fn rpc_open_note(
    State(s): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<OpenNoteReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (_, token, _) = s.runtime.snapshot();
    check_token(&headers, &token)?;
    let path = ensure_in_any_workspace(&s.app, &req.path)?;
    let path_s = path.to_string_lossy().to_string();
    s.app
        .emit("open-from-os", &path_s)
        .map_err(|e| internal(e.to_string()))?;
    Ok(Json(serde_json::json!({ "opened": path_s })))
}

#[derive(Serialize)]
struct VaultDetails {
    active_workspace: Option<String>,
    vaults: Vec<VaultInfo>,
}

async fn rpc_get_vault_info(
    State(s): State<ServerState>,
    headers: HeaderMap,
) -> Result<Json<VaultDetails>, (StatusCode, String)> {
    let (_, token, active) = s.runtime.snapshot();
    check_token(&headers, &token)?;
    let app_state = s.app.state::<AppState>();
    let inner = app_state
        .inner
        .lock()
        .map_err(|e| internal(e.to_string()))?;
    let mut vaults: Vec<VaultInfo> = inner
        .workspaces
        .iter()
        .map(|p| VaultInfo {
            path: p.to_string_lossy().to_string(),
            name: p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        })
        .collect();
    vaults.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(VaultDetails {
        active_workspace: active.map(|p| p.to_string_lossy().to_string()),
        vaults,
    }))
}

// ────────────────────────────── helpers ──────────────────────────────

fn internal(msg: String) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, msg)
}

fn resolve_workspace(
    app: &AppHandle,
    requested: Option<&str>,
    fallback: Option<&Path>,
) -> Result<PathBuf, (StatusCode, String)> {
    let app_state = app.state::<AppState>();
    let inner = app_state
        .inner
        .lock()
        .map_err(|e| internal(e.to_string()))?;

    if let Some(req) = requested {
        let canon = PathBuf::from(req)
            .canonicalize()
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("workspace 路径无效：{e}")))?;
        if inner.workspaces.contains(&canon) {
            return Ok(canon);
        }
        return Err((StatusCode::FORBIDDEN, "workspace 未注册".into()));
    }
    if let Some(p) = fallback {
        if inner.workspaces.contains(p) {
            return Ok(p.to_path_buf());
        }
    }
    // 兜底：只有一个注册的 vault 时直接用
    if inner.workspaces.len() == 1 {
        return Ok(inner.workspaces.iter().next().unwrap().clone());
    }
    Err((
        StatusCode::BAD_REQUEST,
        "没有指定 workspace，并且当前无活跃 vault".into(),
    ))
}

fn ensure_in_any_workspace(app: &AppHandle, path: &str) -> Result<PathBuf, (StatusCode, String)> {
    let app_state = app.state::<AppState>();
    let inner = app_state
        .inner
        .lock()
        .map_err(|e| internal(e.to_string()))?;
    crate::state::ensure_in_workspaces(&inner.workspaces, Path::new(path))
        .map_err(|e| (StatusCode::FORBIDDEN, e))
}

fn collect_notes(root: &Path, limit: usize) -> Vec<NoteSummary> {
    let mut out: Vec<NoteSummary> = Vec::new();
    walk(root, &mut out, 0, limit);
    out
}

fn walk(dir: &Path, out: &mut Vec<NoteSummary>, depth: usize, limit: usize) {
    if depth > 12 || out.len() >= limit {
        return;
    }
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in read.flatten() {
        if out.len() >= limit {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let path = entry.path();
        if ft.is_dir() {
            walk(&path, out, depth + 1, limit);
            continue;
        }
        if !ft.is_file() || !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        out.push(NoteSummary {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or(name),
            size: meta.len(),
        });
    }
}
