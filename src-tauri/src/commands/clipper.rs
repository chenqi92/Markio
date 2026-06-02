//! WebClipper 状态查询 / 配置。ClipperRuntime 由 tauri::manage 注入。

use std::sync::Arc;

use crate::{clipper, validate_path, AppState};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipperStatusDto {
    port: Option<u16>,
    token: Option<String>,
    enabled: bool,
}

#[tauri::command]
pub fn clipper_status(
    runtime: tauri::State<'_, Arc<clipper::ClipperRuntime>>,
) -> ClipperStatusDto {
    let s = runtime.status();
    ClipperStatusDto {
        port: s.port,
        token: s.token,
        enabled: s.enabled,
    }
}

#[tauri::command]
pub fn clipper_set_config(
    runtime: tauri::State<'_, Arc<clipper::ClipperRuntime>>,
    enabled: bool,
    readability: bool,
    html_to_md: bool,
    ai_summary: bool,
) {
    runtime.set_config(enabled, readability, html_to_md, ai_summary);
}

/// 前端生成 AI 摘要后回写到剪藏文件的 frontmatter（路径需在已注册仓库内）。
#[tauri::command]
pub fn clipper_set_summary(
    state: tauri::State<'_, AppState>,
    path: String,
    summary: String,
) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    let content = crate::fs_ops::read_text_path(&canon)?;
    let next = clipper::insert_summary(&content, summary.trim());
    crate::fs_ops::atomic_write(&canon, &next)
}

#[tauri::command]
pub fn clipper_set_active_workspace(
    state: tauri::State<'_, AppState>,
    runtime: tauri::State<'_, Arc<clipper::ClipperRuntime>>,
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
