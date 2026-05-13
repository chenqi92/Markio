mod ai;
mod fs_ops;
mod markdown;
mod secrets;
mod state;

use std::path::{Path, PathBuf};

use serde::Serialize;

use ai::{ChatRequest, ChatResponse};
use fs_ops::{AiContext, Attachment, Backlink, FileEntry, GrepHit, Snapshot, TrashItem};
use markdown::{OutlineItem, RenderResult};
use state::{ensure_in_workspaces, signature_for, AppState, FileSig};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigDto {
    pub mtime: i64,
    pub hash: String,
}
impl From<FileSig> for SigDto {
    fn from(s: FileSig) -> Self {
        Self {
            mtime: s.mtime_ms,
            hash: format!("{:x}", s.hash),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub content: String,
    pub sig: SigDto,
}

fn validate_path(state: &AppState, p: &str) -> Result<PathBuf, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|e| format!("internal lock: {e}"))?;
    ensure_in_workspaces(&inner.workspaces, Path::new(p))
}

// ─── markdown ───────────────────────────────────────────────────────

#[tauri::command]
fn md_render(source: String) -> RenderResult {
    markdown::render(&source)
}

#[tauri::command]
fn md_outline(source: String) -> Vec<OutlineItem> {
    markdown::outline_only(&source)
}

// ─── workspace 注册 ─────────────────────────────────────────────────

#[tauri::command]
fn workspace_register(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let canon = state.register_workspace(Path::new(&path))?;
    Ok(canon.to_string_lossy().to_string())
}

#[tauri::command]
fn workspace_unregister(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    state.unregister_workspace(Path::new(&path))
}

// ─── 树 & 文件 ──────────────────────────────────────────────────────

#[tauri::command]
fn fs_read_tree(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<FileEntry, String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::walk_tree(&canon.to_string_lossy())
}

/// 读取文件 + 记录指纹，前端用 sig 在保存时校验
#[tauri::command]
fn fs_open(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<OpenedFile, String> {
    let canon = validate_path(&state, &path)?;
    let content = fs_ops::read_text_path(&canon)?;
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(OpenedFile {
        path: canon.to_string_lossy().to_string(),
        content,
        sig: sig.into(),
    })
}

#[tauri::command]
fn fs_close(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    state.record_close(p)
}

/// 原子保存 + 冲突检测。
/// - `expected_mtime` 是前端打开 / 上次保存时记下的 mtime
/// - `force` 表示用户主动覆盖
/// - 返回新 sig；冲突时返回 Err("CONFLICT:<current_mtime>:<current_hash>")
#[tauri::command]
fn fs_save(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
    expected_mtime: Option<i64>,
    force: Option<bool>,
) -> Result<SigDto, String> {
    let canon = validate_path(&state, &path)?;
    let forced = force.unwrap_or(false);
    if !forced {
        // 检查磁盘上是否被改过
        if canon.exists() {
            let disk = signature_for(&canon).map_err(|e| e.to_string())?;
            let known = state.last_sig(&canon);
            let baseline_mtime = expected_mtime.or(known.map(|s| s.mtime_ms));
            if let Some(base) = baseline_mtime {
                if disk.mtime_ms > base {
                    return Err(format!(
                        "CONFLICT:{}:{:x}",
                        disk.mtime_ms, disk.hash
                    ));
                }
            }
        }
    }
    fs_ops::atomic_write(&canon, &content)?;
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(sig.into())
}

/// 创建新文件，已存在时返回 Err("ALREADY_EXISTS:<path>")
#[tauri::command]
fn fs_create_new(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
) -> Result<SigDto, String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::create_new(&canon, &content)?;
    let sig = signature_for(&canon).map_err(|e| e.to_string())?;
    state.record_open(&canon, sig)?;
    Ok(sig.into())
}

#[tauri::command]
fn fs_rename(
    state: tauri::State<'_, AppState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let from_p = validate_path(&state, &from)?;
    let to_p = validate_path(&state, &to)?;
    fs_ops::rename(&from_p.to_string_lossy(), &to_p.to_string_lossy())?;
    state.record_close(&from_p)?;
    Ok(())
}

#[tauri::command]
fn fs_delete(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::delete(&canon.to_string_lossy())?;
    state.record_close(&canon)?;
    Ok(())
}

#[tauri::command]
fn fs_mkdir(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::make_dir(&canon.to_string_lossy())
}

#[tauri::command]
fn fs_grep(
    state: tauri::State<'_, AppState>,
    root: String,
    query: String,
    max: Option<usize>,
) -> Result<Vec<GrepHit>, String> {
    let canon = validate_path(&state, &root)?;
    Ok(fs_ops::grep(&canon.to_string_lossy(), &query, max.unwrap_or(80)))
}

#[tauri::command]
fn fs_reveal(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::reveal_in_os(&canon.to_string_lossy())
}

#[tauri::command]
fn fs_list_attachments(
    state: tauri::State<'_, AppState>,
    workspace: String,
    max: Option<usize>,
) -> Result<Vec<Attachment>, String> {
    let canon = validate_path(&state, &workspace)?;
    Ok(fs_ops::list_attachments(
        &canon.to_string_lossy(),
        max.unwrap_or(200),
    ))
}

// ─── 历史快照 ───────────────────────────────────────────────────────

#[tauri::command]
fn history_save(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    content: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    fs_ops::save_snapshot(&ws.to_string_lossy(), &f.to_string_lossy(), &content)
}

#[tauri::command]
fn history_list(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
) -> Result<Vec<Snapshot>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    fs_ops::list_snapshots(&ws.to_string_lossy(), &f.to_string_lossy())
}

#[tauri::command]
fn history_read(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let canon = validate_path(&state, &path)?;
    fs_ops::read_snapshot(&canon.to_string_lossy())
}

// ─── 反链 ───────────────────────────────────────────────────────────

#[tauri::command]
fn fs_backlinks(
    state: tauri::State<'_, AppState>,
    workspace: String,
    file: String,
    max: Option<usize>,
) -> Result<Vec<Backlink>, String> {
    let ws = validate_path(&state, &workspace)?;
    let f = validate_path(&state, &file)?;
    Ok(fs_ops::find_backlinks(
        &ws.to_string_lossy(),
        &f.to_string_lossy(),
        max.unwrap_or(50),
    ))
}

// ─── 回收站 ─────────────────────────────────────────────────────────

#[tauri::command]
fn fs_trash_move(
    state: tauri::State<'_, AppState>,
    workspace: String,
    path: String,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let p = validate_path(&state, &path)?;
    fs_ops::trash_move(&ws.to_string_lossy(), &p.to_string_lossy())?;
    state.record_close(&p)?;
    Ok(())
}

#[tauri::command]
fn fs_trash_list(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<Vec<TrashItem>, String> {
    let ws = validate_path(&state, &workspace)?;
    fs_ops::trash_list(&ws.to_string_lossy())
}

#[tauri::command]
fn fs_trash_restore(
    state: tauri::State<'_, AppState>,
    workspace: String,
    stored: String,
) -> Result<String, String> {
    let ws = validate_path(&state, &workspace)?;
    let s = validate_path(&state, &stored)?;
    fs_ops::trash_restore(&ws.to_string_lossy(), &s.to_string_lossy())
}

#[tauri::command]
fn fs_trash_purge(
    state: tauri::State<'_, AppState>,
    workspace: String,
    stored: Option<String>,
) -> Result<(), String> {
    let ws = validate_path(&state, &workspace)?;
    let stored_p = if let Some(s) = stored {
        Some(validate_path(&state, &s)?.to_string_lossy().to_string())
    } else {
        None
    };
    fs_ops::trash_purge(&ws.to_string_lossy(), stored_p)
}

// ─── 系统钥匙串 ─────────────────────────────────────────────────────

#[tauri::command]
fn secret_set(account: String, value: String) -> Result<(), String> {
    secrets::set(&account, &value)
}

#[tauri::command]
fn secret_get(account: String) -> Result<Option<String>, String> {
    secrets::get(&account)
}

#[tauri::command]
fn secret_has(account: String) -> Result<bool, String> {
    Ok(secrets::has(&account))
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    secrets::delete(&account)
}

// ─── AI ─────────────────────────────────────────────────────────────

/// 关键词检索：从仓库里抽 query 相关的片段（带上下文行），喂给 AI 当 RAG 占位实现。
/// 真正向量 RAG 见 docs/ARCHITECTURE.md「AI · 上下文检索」章节的演进计划。
#[tauri::command]
fn ai_retrieve(
    state: tauri::State<'_, AppState>,
    workspace: String,
    query: String,
    k: Option<usize>,
) -> Result<Vec<AiContext>, String> {
    let ws = validate_path(&state, &workspace)?;
    Ok(fs_ops::retrieve_context(
        &ws.to_string_lossy(),
        &query,
        k.unwrap_or(5),
    ))
}

#[tauri::command]
async fn ai_chat(req: ChatRequest) -> Result<ChatResponse, String> {
    // 如果前端没传 key，从钥匙串读
    let mut req = req;
    if req.api_key.as_ref().map(|k| k.is_empty()).unwrap_or(true) {
        let account = format!("ai:{}", req.provider);
        if let Ok(Some(stored)) = secrets::get(&account) {
            req.api_key = Some(stored);
        }
    }
    ai::chat(req).await
}

// ─── 入口 ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            md_render,
            md_outline,
            workspace_register,
            workspace_unregister,
            fs_read_tree,
            fs_open,
            fs_close,
            fs_save,
            fs_create_new,
            fs_rename,
            fs_delete,
            fs_mkdir,
            fs_grep,
            fs_reveal,
            fs_list_attachments,
            history_save,
            history_list,
            history_read,
            fs_backlinks,
            fs_trash_move,
            fs_trash_list,
            fs_trash_restore,
            fs_trash_purge,
            secret_set,
            secret_get,
            secret_has,
            secret_delete,
            ai_chat,
            ai_retrieve,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
