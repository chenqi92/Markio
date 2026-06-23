//! P2P 局域网同步：mDNS 发现 + WebSocket 金库 RPC server + 配对。
//!
//! 模型（桌面 ↔ 桌面）：
//! - 每个实例有稳定 `device_id` 与持久 `auth_token`（金库访问令牌，存 OS 钥匙串）。
//! - mDNS 广播 `_markio._tcp.local.`（含 id/name/port），并浏览同网段其它实例。
//! - 配对：A 打开配对窗口显示 6 位 code；B 连 A 的 `/pair` 出示 code，换回 A 的 auth_token，存为已配对设备。
//! - 同步：B 用该 token 连 A 的 `/sync` WS，跑金库 RPC（list/get/put/delete/mkdir）。
//!   前端 sync 引擎用 P2PAdapter 把这些 RPC 当作一个「云盘」，复用现成的三方 diff。
//!
//! 安全：WS server bind 0.0.0.0（LAN 可达，P2P 必需），但所有 `/sync` 操作都要 auth_token，
//! 且金库 RPC 仍过仓库 allowlist（沿用 fs_sync_* 的校验）。仅当 mobileP2pEnabled 时才启动。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;

use crate::state::AppState;

const SERVICE_TYPE: &str = "_markio._tcp.local.";

#[derive(Default)]
pub struct P2pRuntime {
    inner: RwLock<Inner>,
    started: std::sync::atomic::AtomicBool,
}

#[derive(Default, Clone)]
struct Inner {
    enabled: bool,
    device_id: String,
    device_name: String,
    ws_port: Option<u16>,
    auth_token: Option<String>,
    active_workspace: Option<PathBuf>,
    /// mDNS 发现的对端（device_id -> Peer）
    peers: HashMap<String, Peer>,
    /// 当前开放的配对会话（本机作为被配对方）
    pairing: Option<PairingSession>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub device_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub version: String,
    /// mDNS 服务实例全名，仅用于下线时按 fullname 删除该对端，不下发前端。
    #[serde(skip)]
    pub fullname: String,
}

#[derive(Clone)]
struct PairingSession {
    code: String,
    expires_at_ms: u128,
    /// 已失败的配对尝试次数；超过上限即关闭窗口，防止 6 位码被暴力枚举。
    failed_attempts: u32,
}

/// 单个配对窗口内允许的最大错误尝试次数。6 位码空间 1e6，限到 5 次后
/// 暴力成功率约 5e-6，可忽略。
const MAX_PAIR_ATTEMPTS: u32 = 5;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pStatus {
    pub enabled: bool,
    pub device_id: String,
    pub device_name: String,
    pub ws_port: Option<u16>,
    pub pairing_open: bool,
    pub peers: Vec<Peer>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl P2pRuntime {
    pub fn status(&self) -> P2pStatus {
        let g = self.inner.read().unwrap();
        let mut peers: Vec<Peer> = g.peers.values().cloned().collect();
        peers.sort_by(|a, b| a.name.cmp(&b.name));
        let pairing_open = g
            .pairing
            .as_ref()
            .is_some_and(|p| p.expires_at_ms > now_ms());
        P2pStatus {
            enabled: g.enabled,
            device_id: g.device_id.clone(),
            device_name: g.device_name.clone(),
            ws_port: g.ws_port,
            pairing_open,
            peers,
        }
    }

    pub fn set_identity(&self, device_id: String, device_name: String, auth_token: String) {
        let mut g = self.inner.write().unwrap();
        g.device_id = device_id;
        g.device_name = device_name;
        g.auth_token = Some(auth_token);
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.inner.write().unwrap().enabled = enabled;
    }

    /// 首次需要启动 server 时返回 true（之后恒为 false），用于懒启动只跑一次。
    pub fn try_start(&self) -> bool {
        !self.started.swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    pub fn set_active_workspace(&self, p: Option<PathBuf>) {
        self.inner.write().unwrap().active_workspace = p;
    }

    fn set_port(&self, port: u16) {
        self.inner.write().unwrap().ws_port = Some(port);
    }

    /// 打开一个配对窗口（默认 5 分钟），返回 6 位 code。
    pub fn open_pairing(&self) -> String {
        let code = gen_pair_code();
        let mut g = self.inner.write().unwrap();
        g.pairing = Some(PairingSession {
            code: code.clone(),
            expires_at_ms: now_ms() + 5 * 60 * 1000,
            failed_attempts: 0,
        });
        code
    }

    pub fn close_pairing(&self) {
        self.inner.write().unwrap().pairing = None;
    }

    /// 记一次配对失败；达到上限后关闭窗口。返回 true 表示窗口已因超限关闭。
    fn register_pair_failure(&self) -> bool {
        let mut g = self.inner.write().unwrap();
        if let Some(p) = g.pairing.as_mut() {
            p.failed_attempts += 1;
            if p.failed_attempts >= MAX_PAIR_ATTEMPTS {
                g.pairing = None;
                return true;
            }
        }
        false
    }

    fn snapshot(&self) -> Inner {
        self.inner.read().unwrap().clone()
    }

    fn upsert_peer(&self, p: Peer) {
        let mut g = self.inner.write().unwrap();
        if p.device_id != g.device_id {
            g.peers.insert(p.device_id.clone(), p);
        }
    }

    fn remove_peer_by_fullname(&self, fullname: &str) {
        // mDNS 下线事件给的是服务实例 fullname；删掉对应对端，避免离线设备滞留在
        // peers 表里害得自动同步反复对其做 10s WS 超时。
        let mut g = self.inner.write().unwrap();
        g.peers.retain(|_, p| p.fullname != fullname);
    }
}

fn gen_pair_code() -> String {
    // CSPRNG 不可用时 fail-closed（panic）而非退化成低熵的时间戳^pid——配对码是
    // 防止冒充配对的唯一一道随机性，弱熵会让其可预测。宁可拒绝配对也不发弱码。
    let mut buf = [0u8; 4];
    getrandom::getrandom(&mut buf).expect("系统 CSPRNG 不可用，无法安全生成配对码");
    let raw = u32::from_le_bytes(buf);
    let n = raw % 1_000_000;
    format!("{n:06}")
}

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    runtime: Arc<P2pRuntime>,
}

/// 启动 P2P：WS server + mDNS 广播/浏览。仅在 enabled 时启动。
pub fn spawn(app: AppHandle, runtime: Arc<P2pRuntime>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app, runtime).await {
            eprintln!("[p2p] 启动失败：{e}");
        }
    });
}

async fn run(app: AppHandle, runtime: Arc<P2pRuntime>) -> Result<(), String> {
    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("bind 失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    runtime.set_port(port);

    // mDNS 广播 + 浏览（失败不致命，发现能力降级但 WS 仍可用直连）
    if let Err(e) = start_mdns(runtime.clone(), port) {
        eprintln!("[p2p] mDNS 启动失败（仅影响自动发现）：{e}");
    }

    let state = ServerState {
        app,
        runtime: runtime.clone(),
    };
    let router = Router::new()
        .route("/pair", get(ws_pair))
        .route("/sync", get(ws_sync))
        .with_state(state);

    eprintln!("[p2p] WS listening on 0.0.0.0:{port}");
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("axum serve: {e}"))
}

// ───────────────────────────── mDNS ─────────────────────────────

fn start_mdns(runtime: Arc<P2pRuntime>, port: u16) -> Result<(), String> {
    use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

    let snap = runtime.snapshot();
    let mdns = ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;

    let instance = if snap.device_id.is_empty() {
        "markio".to_string()
    } else {
        snap.device_id.clone()
    };
    let host = format!("{instance}.local.");
    let version = env!("CARGO_PKG_VERSION").to_string();
    let props: [(&str, &str); 3] = [
        ("id", snap.device_id.as_str()),
        ("name", snap.device_name.as_str()),
        ("ver", version.as_str()),
    ];
    match ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, &props[..]) {
        Ok(info) => {
            let info = info.enable_addr_auto();
            if let Err(e) = mdns.register(info) {
                eprintln!("[p2p] mDNS register 失败：{e}");
            }
        }
        Err(e) => eprintln!("[p2p] mDNS ServiceInfo 失败：{e}"),
    }

    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("mDNS browse: {e}"))?;
    let rt = runtime.clone();
    // mdns-sd 的 receiver 是同步 channel，放到阻塞线程里读
    std::thread::spawn(move || {
        while let Ok(event) = receiver.recv() {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let props = info.get_properties();
                    let device_id = props.get_property_val_str("id").unwrap_or("").to_string();
                    if device_id.is_empty() {
                        continue;
                    }
                    let name = props.get_property_val_str("name").unwrap_or("").to_string();
                    let version = props.get_property_val_str("ver").unwrap_or("").to_string();
                    let host = info
                        .get_addresses()
                        .iter()
                        .next()
                        .map(|ip| ip.to_string())
                        .unwrap_or_default();
                    if host.is_empty() {
                        continue;
                    }
                    rt.upsert_peer(Peer {
                        device_id,
                        name,
                        host,
                        port: info.get_port(),
                        version,
                        fullname: info.get_fullname().to_string(),
                    });
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    rt.remove_peer_by_fullname(&fullname);
                }
                _ => {}
            }
        }
        // daemon 随线程持有；进程退出时一并回收
        let _ = mdns;
    });
    Ok(())
}

// ───────────────────────────── WS: 配对 ─────────────────────────────

#[derive(Deserialize)]
struct PairHello {
    code: String,
}

#[derive(Serialize)]
struct PairReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn ws_pair(ws: WebSocketUpgrade, State(s): State<ServerState>) -> Response {
    ws.on_upgrade(move |socket| handle_pair(socket, s))
}

async fn handle_pair(mut socket: WebSocket, s: ServerState) {
    let Some(Ok(Message::Text(first))) = socket.recv().await else {
        return;
    };
    let hello: PairHello = match serde_json::from_str(&first) {
        Ok(h) => h,
        Err(_) => {
            let _ = send_json(&mut socket, &pair_err("bad request")).await;
            return;
        }
    };
    let snap = s.runtime.snapshot();
    let valid = snap
        .pairing
        .as_ref()
        .is_some_and(|p| p.expires_at_ms > now_ms() && constant_eq(&p.code, &hello.code));
    if !valid {
        // 记失败并在超限时关闭窗口，阻断对 6 位码的暴力枚举
        let locked = s.runtime.register_pair_failure();
        let msg = if locked {
            "配对失败次数过多，窗口已关闭"
        } else {
            "配对码无效或已过期"
        };
        let _ = send_json(&mut socket, &pair_err(msg)).await;
        return;
    }
    let reply = PairReply {
        ok: true,
        device_id: Some(snap.device_id.clone()),
        device_name: Some(snap.device_name.clone()),
        token: snap.auth_token.clone(),
        error: None,
    };
    let _ = send_json(&mut socket, &reply).await;
    // 一次性：配对成功后关闭窗口
    s.runtime.close_pairing();
}

fn pair_err(msg: &str) -> PairReply {
    PairReply {
        ok: false,
        device_id: None,
        device_name: None,
        token: None,
        error: Some(msg.to_string()),
    }
}

// ───────────────────────────── WS: 同步金库 RPC ─────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum RpcReq {
    Auth {
        token: String,
    },
    List,
    Get {
        rel_path: String,
    },
    Put {
        rel_path: String,
        content_base64: String,
    },
    Delete {
        rel_path: String,
    },
    Mkdir {
        rel_path: String,
    },
}

#[derive(Serialize)]
struct RpcResp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn rpc_ok(v: serde_json::Value) -> RpcResp {
    RpcResp {
        ok: true,
        result: Some(v),
        error: None,
    }
}
fn rpc_err(e: impl Into<String>) -> RpcResp {
    RpcResp {
        ok: false,
        result: None,
        error: Some(e.into()),
    }
}

async fn ws_sync(ws: WebSocketUpgrade, State(s): State<ServerState>) -> Response {
    ws.on_upgrade(move |socket| handle_sync(socket, s))
}

async fn handle_sync(mut socket: WebSocket, s: ServerState) {
    let mut authed = false;
    while let Some(Ok(msg)) = socket.recv().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
        };
        let req: RpcReq = match serde_json::from_str(&text) {
            Ok(r) => r,
            Err(e) => {
                let _ = send_json(&mut socket, &rpc_err(format!("bad request: {e}"))).await;
                continue;
            }
        };

        // 第一帧必须 auth
        if !authed {
            if let RpcReq::Auth { token } = &req {
                let snap = s.runtime.snapshot();
                let ok = snap
                    .auth_token
                    .as_ref()
                    .is_some_and(|t| constant_eq(t, token))
                    && snap.enabled;
                authed = ok;
                let resp = if ok {
                    rpc_ok(serde_json::json!({"authed": true}))
                } else {
                    rpc_err("auth 失败")
                };
                let _ = send_json(&mut socket, &resp).await;
                if !ok {
                    break;
                }
                continue;
            } else {
                let _ = send_json(&mut socket, &rpc_err("需要先 auth")).await;
                break;
            }
        }

        let resp = handle_rpc(&s, req).await;
        if send_json(&mut socket, &resp).await.is_err() {
            break;
        }
    }
}

async fn handle_rpc(s: &ServerState, req: RpcReq) -> RpcResp {
    let snap = s.runtime.snapshot();
    let Some(ws) = snap.active_workspace.clone() else {
        return rpc_err("对端未选择活跃仓库");
    };
    let ws_str = ws.to_string_lossy().to_string();
    let app = s.app.clone();

    match req {
        RpcReq::Auth { .. } => rpc_ok(serde_json::json!({"authed": true})),
        RpcReq::List => {
            let res =
                tauri::async_runtime::spawn_blocking(move || crate::sync_scan_workspace(&ws)).await;
            match res {
                Ok(entries) => match serde_json::to_value(entries) {
                    Ok(v) => rpc_ok(v),
                    Err(e) => rpc_err(e.to_string()),
                },
                Err(e) => rpc_err(e.to_string()),
            }
        }
        RpcReq::Get { rel_path } => {
            blocking_state(app, move |state| {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                let path = crate::resolve_sync_user_path(state, &ws_str, &rel_path)?;
                let b64 = crate::read_file_base64_checked(&path)?;
                // 同时回 hash/mtime，供对端 sync 引擎写基线（与 list 的 hash 口径一致）
                let bytes = STANDARD.decode(b64.trim()).unwrap_or_default();
                let hash = format!("{:x}", crate::state::hash64(&bytes));
                let mtime = file_mtime_ms(&path);
                Ok(serde_json::json!({ "contentBase64": b64, "etag": hash, "mtime": mtime }))
            })
            .await
        }
        RpcReq::Put {
            rel_path,
            content_base64,
        } => {
            blocking_state(app, move |state| {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                if content_base64.len() > 70 * 1024 * 1024 {
                    return Err("内容过大".to_string());
                }
                let bytes = STANDARD
                    .decode(content_base64.trim())
                    .map_err(|e| format!("非法 base64：{e}"))?;
                let path = crate::resolve_sync_user_path(state, &ws_str, &rel_path)?;
                crate::atomic_write_bytes(&path, &bytes)?;
                let mtime = file_mtime_ms(&path);
                let hash = format!("{:x}", crate::state::hash64(&bytes));
                Ok(serde_json::json!({ "etag": hash, "mtime": mtime }))
            })
            .await
        }
        RpcReq::Delete { rel_path } => {
            blocking_state(app, move |state| {
                let ws_canon = crate::validate_path(state, &ws_str)?;
                let path = crate::resolve_sync_user_path(state, &ws_str, &rel_path)?;
                crate::fs_ops::trash_move(&ws_canon.to_string_lossy(), &path.to_string_lossy())?;
                Ok(serde_json::json!({ "deleted": true }))
            })
            .await
        }
        RpcReq::Mkdir { rel_path } => {
            // 金库 RPC 的目录隐含在 put 的父目录创建里；这里仅校验路径合法即可
            blocking_state(app, move |state| {
                crate::resolve_sync_user_path(state, &ws_str, &format!("{rel_path}/.keep"))?;
                Ok(serde_json::json!({ "ok": true }))
            })
            .await
        }
    }
}

/// 在阻塞线程里拿 AppState 跑一段返回 JSON 的逻辑。
async fn blocking_state<F>(app: AppHandle, f: F) -> RpcResp
where
    F: FnOnce(&AppState) -> Result<serde_json::Value, String> + Send + 'static,
{
    let res = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        f(&state)
    })
    .await;
    match res {
        Ok(Ok(v)) => rpc_ok(v),
        Ok(Err(e)) => rpc_err(e),
        Err(e) => rpc_err(e.to_string()),
    }
}

fn file_mtime_ms(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ───────────────────────────── helpers ─────────────────────────────

async fn send_json<T: Serialize>(socket: &mut WebSocket, v: &T) -> Result<(), ()> {
    let body = serde_json::to_string(v).map_err(|_| ())?;
    socket.send(Message::Text(body)).await.map_err(|_| ())
}

/// 常量时间比较，避免 token / code 计时侧信道。
fn constant_eq(a: &str, b: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_code_is_six_digits() {
        let c = gen_pair_code();
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn constant_eq_works() {
        assert!(constant_eq("abc", "abc"));
        assert!(!constant_eq("abc", "abd"));
        assert!(!constant_eq("abc", "abcd"));
    }
}
