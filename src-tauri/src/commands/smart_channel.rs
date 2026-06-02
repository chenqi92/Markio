//! SmartChannel 入站状态 / 配置 / 回包。SmartChannelRuntime 由 tauri::manage 注入。

use std::sync::Arc;

use crate::smart_channel;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartChannelStatusDto {
    port: Option<u16>,
    token: Option<String>,
    enabled: bool,
    channel_id: Option<String>,
}

#[tauri::command]
pub fn smart_channel_status(
    runtime: tauri::State<'_, Arc<smart_channel::SmartChannelRuntime>>,
) -> SmartChannelStatusDto {
    let s = runtime.status();
    SmartChannelStatusDto {
        port: s.port,
        token: s.token,
        enabled: s.enabled,
        channel_id: s.channel_id,
    }
}

#[tauri::command]
pub fn smart_channel_set_config(
    runtime: tauri::State<'_, Arc<smart_channel::SmartChannelRuntime>>,
    enabled: bool,
    channel_id: Option<String>,
) {
    runtime.set_config(enabled, channel_id);
}

/// 前端跑完 smartChannelQuery 后把结果送回对应的在途入站请求。
/// payload 形如 { ok: bool, answer?, refs?, model?, error? }。
#[tauri::command]
pub fn smart_channel_respond(
    runtime: tauri::State<'_, Arc<smart_channel::SmartChannelRuntime>>,
    id: String,
    payload: serde_json::Value,
) -> bool {
    runtime.resolve(&id, payload)
}
