//! 本地 AI Agent CLI 包装：列举可用 provider、跑 / 取消会话。
//! 实际逻辑在 `crate::agent_cli`。

use crate::agent_cli;

#[tauri::command]
pub fn agent_list_providers() -> Vec<agent_cli::ProviderInfo> {
    agent_cli::detect_providers()
}

#[tauri::command]
pub async fn agent_run(
    app: tauri::AppHandle,
    req: agent_cli::AgentRunRequest,
) -> Result<(), String> {
    // 不阻塞调用方：spawn 到 tauri runtime
    tauri::async_runtime::spawn(async move { agent_cli::run(app, req).await });
    Ok(())
}

#[tauri::command]
pub fn agent_cancel(session_id: String) {
    agent_cli::cancel_session(&session_id);
}
