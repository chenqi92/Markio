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
pub fn p2p_open_pairing(
    runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>,
) -> String {
    runtime.open_pairing()
}

#[tauri::command]
pub fn p2p_close_pairing(runtime: tauri::State<'_, Arc<p2p::P2pRuntime>>) {
    runtime.close_pairing();
}
