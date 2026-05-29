//! MCP server 状态查询 / 设置默认 vault。
//!
//! McpRuntime 由 tauri::manage 注入，命令侧只读 / 调度。

use std::sync::Arc;

use crate::{mcp, validate_path, AppState};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    port: Option<u16>,
    token: Option<String>,
    active_workspace: Option<String>,
}

#[tauri::command]
pub fn mcp_status(runtime: tauri::State<'_, Arc<mcp::McpRuntime>>) -> McpStatus {
    let (port, token, ws) = runtime.snapshot();
    McpStatus {
        port,
        token,
        active_workspace: ws.map(|p| p.to_string_lossy().to_string()),
    }
}

/// 前端在切 vault 时调用，让 mcp server 在没有指定 workspace 时使用这个。
#[tauri::command]
pub fn mcp_set_active_workspace(
    state: tauri::State<'_, AppState>,
    runtime: tauri::State<'_, Arc<mcp::McpRuntime>>,
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
