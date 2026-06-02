//! SmartChannel 入站 loopback HTTP server。
//!
//! 外部 app（Raycast / Alfred / 脚本 / 微信助手中转）POST 一个自然语言问题进来，
//! 由本机的 markio 检索仓库 + 调 AI 生成回答返回。
//!
//! 设计：检索 + AI 回答的全部策略（区域合规、模型来源、风格、每日配额）都已在前端
//! `src/lib/smartChannel.ts` 实现。这里不重复一份，而是把入站请求**桥接**给前端：
//!   1. HTTP handler 生成 request id + oneshot，挂到 pending 表，emit `smart-channel-request` 事件
//!   2. 前端监听该事件 → 跑 smartChannelQuery → 调命令 `smart_channel_respond(id, payload)`
//!   3. handler 在 oneshot 上等回包（带超时），原样返回 JSON
//!
//! 安全模型同 mcp/clipper：仅 bind 127.0.0.1、Bearer token 鉴权。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// 全局可见的 SmartChannel 端口 / token / 配置 + 在途请求表。
#[derive(Default)]
pub struct SmartChannelRuntime {
    inner: RwLock<Inner>,
    pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    seq: AtomicU64,
}

#[derive(Default, Clone)]
struct Inner {
    port: Option<u16>,
    token: Option<String>,
    enabled: bool,
    channel_id: Option<String>,
}

#[derive(Clone)]
pub struct SmartChannelStatus {
    pub port: Option<u16>,
    pub token: Option<String>,
    pub enabled: bool,
    pub channel_id: Option<String>,
}

impl SmartChannelRuntime {
    pub fn status(&self) -> SmartChannelStatus {
        let g = self.inner.read().unwrap();
        SmartChannelStatus {
            port: g.port,
            token: g.token.clone(),
            enabled: g.enabled,
            channel_id: g.channel_id.clone(),
        }
    }

    pub fn set_config(&self, enabled: bool, channel_id: Option<String>) {
        let mut g = self.inner.write().unwrap();
        g.enabled = enabled;
        g.channel_id = channel_id;
    }

    fn set_started(&self, port: u16, token: String) {
        let mut g = self.inner.write().unwrap();
        g.port = Some(port);
        g.token = Some(token);
    }

    fn snapshot(&self) -> Inner {
        self.inner.read().unwrap().clone()
    }

    fn next_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::Relaxed);
        format!("scq-{n}")
    }

    fn register_pending(&self, id: String, tx: oneshot::Sender<serde_json::Value>) {
        self.pending.lock().unwrap().insert(id, tx);
    }

    fn take_pending(&self, id: &str) -> Option<oneshot::Sender<serde_json::Value>> {
        self.pending.lock().unwrap().remove(id)
    }

    /// 前端通过命令把回包送回对应的在途请求。
    pub fn resolve(&self, id: &str, payload: serde_json::Value) -> bool {
        if let Some(tx) = self.take_pending(id) {
            tx.send(payload).is_ok()
        } else {
            false
        }
    }
}

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    runtime: Arc<SmartChannelRuntime>,
}

pub fn spawn(app: AppHandle, runtime: Arc<SmartChannelRuntime>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app, runtime).await {
            eprintln!("[smart-channel] server 启动失败：{e}");
        }
    });
}

async fn run(app: AppHandle, runtime: Arc<SmartChannelRuntime>) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = crate::random_loopback_token();
    runtime.set_started(port, token);

    let state = ServerState {
        app,
        runtime: runtime.clone(),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/query", post(query))
        .with_state(state);

    eprintln!("[smart-channel] listening on http://127.0.0.1:{port}");
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("axum serve: {e}"))
}

fn check_token(headers: &HeaderMap, expected: &Option<String>) -> Result<(), (StatusCode, String)> {
    let Some(want) = expected else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "SmartChannel 尚未就绪".into()));
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

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "markio-smart-channel" }))
}

#[derive(Deserialize)]
struct QueryReq {
    query: String,
    scope: Option<String>,
    #[serde(rename = "modelSource")]
    model_source: Option<String>,
    #[serde(rename = "maxChunks")]
    max_chunks: Option<u32>,
}

async fn query(
    State(s): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<QueryReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let cfg = s.runtime.snapshot();
    check_token(&headers, &cfg.token)?;
    if !cfg.enabled {
        return Err((StatusCode::FORBIDDEN, "SmartChannel 未启用".into()));
    }
    let query = req.query.trim();
    if query.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "query 不能为空".into()));
    }
    if query.len() > 8192 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "query 过长".into()));
    }

    let id = s.runtime.next_id();
    let (tx, rx) = oneshot::channel();
    s.runtime.register_pending(id.clone(), tx);

    let payload = serde_json::json!({
        "id": id,
        "query": query,
        "scope": req.scope,
        "modelSource": req.model_source,
        "maxChunks": req.max_chunks,
    });
    if let Err(e) = s.app.emit("smart-channel-request", &payload) {
        s.runtime.take_pending(&id);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("派发请求失败：{e}")));
    }

    match tokio::time::timeout(Duration::from_secs(120), rx).await {
        Ok(Ok(reply)) => {
            // reply 形如 { ok: bool, answer?, refs?, model?, error? }
            let ok = reply.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if ok {
                Ok(Json(reply))
            } else {
                let msg = reply
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("查询失败")
                    .to_string();
                Err((StatusCode::BAD_GATEWAY, msg))
            }
        }
        Ok(Err(_)) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "前端未返回结果（可能窗口已关闭）".into(),
        )),
        Err(_) => {
            s.runtime.take_pending(&id);
            Err((StatusCode::GATEWAY_TIMEOUT, "查询超时（120s）".into()))
        }
    }
}
