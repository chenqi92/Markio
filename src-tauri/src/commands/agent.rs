//! 本地 AI Agent CLI 包装：列举可用 provider、跑 / 取消会话。
//! 实际逻辑在 `crate::agent_cli`。

use crate::agent_cli;
use crate::state::AppState;

#[tauri::command]
pub fn agent_list_providers() -> Vec<agent_cli::ProviderInfo> {
    agent_cli::detect_providers()
}

#[tauri::command]
pub async fn agent_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    req: agent_cli::AgentRunRequest,
) -> Result<(), String> {
    // 安全：校验 req.workspace 落在已注册仓库内，否则会在任意目录启动一个可自动改文件
    // 的 CLI（PowerUser 模式 acceptEdits），绕过其它 fs_* 命令统一遵守的沙箱。
    if let Some(ws) = req.workspace.as_deref() {
        crate::validate_path(&state, ws)?;
    }
    // 不阻塞调用方：spawn 到 tauri runtime
    tauri::async_runtime::spawn(async move { agent_cli::run(app, req).await });
    Ok(())
}

#[tauri::command]
pub fn agent_cancel(session_id: String) {
    agent_cli::cancel_session(&session_id);
}
