//! 第三方笔记导入：notion / obsidian / bear / evernote / roam / logseq /
//! apple_notes；外加旧增量目录的列出与清理。
//!
//! 实际转换逻辑在 `crate::import` 模块；这层只做 workspace 校验 + 异步调度。

use crate::{import, validate_path, AppState};

#[tauri::command]
pub async fn import_run(
    state: tauri::State<'_, AppState>,
    provider: String,
    source: String,
    workspace: String,
) -> Result<import::ImportReport, String> {
    let ws = validate_path(&state, &workspace)?;
    let src = std::path::PathBuf::from(&source);
    if !src.exists() {
        return Err(format!("源路径不存在：{source}"));
    }
    tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "notion" => import::import_notion(&src, &ws),
        "obsidian" => import::import_obsidian(&src, &ws),
        "bear" => import::import_bear(&src, &ws),
        "evernote" => import::import_evernote(&src, &ws),
        "roam" => import::import_roam(&src, &ws),
        "logseq" => import::import_logseq(&src, &ws),
        other => Err(format!("未知导入器：{other}")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Apple Notes 导入（macOS 专属）：不需要 source 路径，直接调系统 Notes.app。
/// 首次会弹「markio 想要访问 Notes 数据」系统对话框。
#[tauri::command]
pub async fn import_apple_notes(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<import::ImportReport, String> {
    let ws = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || import::import_apple_notes(&ws))
        .await
        .map_err(|e| e.to_string())?
}

/// 列出 workspace/imports 下旧的时间戳目录（增量切换前留下的）。
#[tauri::command]
pub fn import_list_legacy_dirs(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<import::LegacyImportDir>, String> {
    let ws = validate_path(&state, &workspace)?;
    import::list_legacy_import_dirs(&ws)
}

/// 把一个旧时间戳目录移到 .markio/trash（可恢复，不真删）。
#[tauri::command]
pub fn import_trash_legacy_dir(
    state: tauri::State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let p = std::path::PathBuf::from(&path);
    import::trash_legacy_import_dir(&ws, &p)
}
