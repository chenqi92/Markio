//! 文件历史快照：保存 / 列出 / 读取单条 / 跨仓库时间线。
//!
//! 依赖 fs_ops 里的 snapshot store；权限校验复用 lib.rs 的 validate_path /
//! ensure_path_in_workspace / ensure_user_file_path / ensure_history_path /
//! workspace_for_path。

use crate::fs_ops::{self, Snapshot, TimelineEntry};
use crate::{
    ensure_history_path, ensure_path_in_workspace, ensure_user_file_path, validate_path,
    workspace_for_path, AppState,
};

#[tauri::command]
pub fn history_save(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    ensure_path_in_workspace(&ws, &f, "保存历史")?;
    ensure_user_file_path(&state, &f, "保存历史")?;
    fs_ops::save_snapshot(&ws.to_string_lossy(), &f.to_string_lossy(), &content)
}

#[tauri::command]
pub fn history_list(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
) -> Result<Vec<Snapshot>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    ensure_path_in_workspace(&ws, &f, "读取历史")?;
    ensure_user_file_path(&state, &f, "读取历史")?;
    fs_ops::list_snapshots(&ws.to_string_lossy(), &f.to_string_lossy())
}

#[tauri::command]
pub fn history_read(state: tauri::State<'_, AppState>, path: String) -> Result<String, String> {
    let canon = validate_path(&state, &path)?;
    let ws = workspace_for_path(&state, &canon)?;
    ensure_history_path(&ws, &canon)?;
    fs_ops::read_snapshot(&canon.to_string_lossy())
}

/// 跨 workspace 的全量时间线：返回 .markio/history/ 里所有快照（倒序）。
#[tauri::command]
pub fn history_list_all(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<TimelineEntry>, String> {
    let ws = validate_path(&state, &workspace)?;
    fs_ops::list_all_snapshots(&ws.to_string_lossy())
}
