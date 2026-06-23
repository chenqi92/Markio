//! P2P 局域网同步：状态 / 配置 / 配对。P2pRuntime 由 tauri::manage 注入。
//!
//! 配对与同步的「客户端」一侧（连对端 /pair 与 /sync）走前端 WebSocket，
//! 这里只负责本机 server 的开关、身份、活跃仓库与配对窗口。

use std::sync::Arc;

use crate::{p2p, secrets, validate_path, AppState};

/// 稳定身份（device_id + 金库 auth_token）持久化在 OS 钥匙串。
const P2P_IDENTITY_ACCOUNT: &str = "p2p_identity";

fn short_id() -> String {
    let mut buf = [0u8; 8];
    let _ = getrandom::getrandom(&mut buf);
    hex::encode(buf)
}

/// 读取或首次生成本机 P2P 身份。
fn load_or_create_identity() -> Result<(String, String), String> {
    if let Some(s) = secrets::get(P2P_IDENTITY_ACCOUNT)? {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let (Some(id), Some(tok)) = (
                v.get("deviceId").and_then(|x| x.as_str()),
                v.get("token").and_then(|x| x.as_str()),
            ) {
                if !id.is_empty() && !tok.is_empty() {
                    return Ok((id.to_string(), tok.to_string()));
                }
            }
        }
    }
    let id = short_id();
    let token = crate::random_loopback_token();
    let json = serde_json::json!({ "deviceId": id, "token": token }).to_string();
    secrets::set(P2P_IDENTITY_ACCOUNT, &json)?;
    Ok((id, token))
}

#[tauri::command]
pub fn p2p_status(runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>) -> p2p::P2pStatus {
    runtime.status()
}

/// 设置开关 + 设备名；首次启用时懒启动 server（mDNS + WS）。返回本机 device_id。
#[tauri::command]
pub fn p2p_set_config(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>,
    enabled: bool,
    device_name: String,
) -> Result<String, String> {
    let (device_id, token) = load_or_create_identity()?;
    runtime.set_identity(device_id.clone(), device_name, token);
    runtime.set_enabled(enabled);
    if enabled && runtime.try_start() {
        let rt = runtime.inner().clone();
        p2p::spawn(app, rt);
    }
    Ok(device_id)
}

#[tauri::command]
pub fn p2p_set_active_workspace(
    state: tauri::State<'_, AppState>,
    runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>,
    workspace: Option<String>,
) -> Result<(), String> {
    match workspace {
        Some(p) => {
            let canon = validate_path(&state, &p)?;
            runtime.set_active_workspace(Some(canon));
        }
        None => runtime.set_active_workspace(None),
    }
    Ok(())
}

/// 打开配对窗口（5 分钟），返回 6 位配对码给用户口头/扫码告诉对端。
#[tauri::command]
pub fn p2p_open_pairing(runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>) -> String {
    runtime.open_pairing()
}

#[tauri::command]
pub fn p2p_close_pairing(runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>) {
    runtime.close_pairing();
}

/// 已配对对端的金库 token 钥匙串账户名。每个 peer 一条，避免与本机身份账户冲突。
fn peer_token_account(peer_id: &str) -> Result<String, String> {
    // 约束 peer_id 形态，避免拼出意外的钥匙串账户名。
    let ok = !peer_id.is_empty()
        && peer_id.len() <= 128
        && peer_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err("非法 peerId".to_string());
    }
    Ok(format!("p2p_peer:{peer_id}"))
}

/// 存对端金库 token（配对成功后调用），落 OS 钥匙串而非明文 store.bin。
#[tauri::command]
pub fn p2p_token_set(peer_id: String, token: String) -> Result<(), String> {
    secrets::set(&peer_token_account(&peer_id)?, &token)
}

/// 读对端金库 token（同步握手前调用）。
///
/// 这是对「前端不读取 secret 明文」原则的受控例外：P2P 同步的 WS auth 帧在前端
/// 构造，该 token 本就必须被前端持有；改走钥匙串只是把「静态明文落盘」换成
/// 「用时临时读入内存」，运行时暴露面与现状一致，而静态安全性更高。
#[tauri::command]
pub fn p2p_token_get(peer_id: String) -> Result<Option<String>, String> {
    secrets::get(&peer_token_account(&peer_id)?)
}

/// 删除对端金库 token（解除配对时调用）。
#[tauri::command]
pub fn p2p_token_delete(peer_id: String) -> Result<(), String> {
    secrets::delete(&peer_token_account(&peer_id)?)
}
