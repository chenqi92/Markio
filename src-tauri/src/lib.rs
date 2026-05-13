mod ai;
mod fs_ops;
mod markdown;

use ai::{ChatRequest, ChatResponse};
use fs_ops::{Backlink, FileEntry, GrepHit, Snapshot, TrashItem};
use markdown::{OutlineItem, RenderResult};

#[tauri::command]
fn md_render(source: String) -> RenderResult {
    markdown::render(&source)
}

#[tauri::command]
fn md_outline(source: String) -> Vec<OutlineItem> {
    markdown::outline_only(&source)
}

#[tauri::command]
fn fs_read_tree(path: String) -> Result<FileEntry, String> {
    fs_ops::walk_tree(&path)
}

#[tauri::command]
fn fs_read_text(path: String) -> Result<String, String> {
    fs_ops::read_text(&path)
}

#[tauri::command]
fn fs_write_text(path: String, content: String) -> Result<(), String> {
    fs_ops::write_text(&path, &content)
}

#[tauri::command]
fn fs_rename(from: String, to: String) -> Result<(), String> {
    fs_ops::rename(&from, &to)
}

#[tauri::command]
fn fs_delete(path: String) -> Result<(), String> {
    fs_ops::delete(&path)
}

#[tauri::command]
fn fs_mkdir(path: String) -> Result<(), String> {
    fs_ops::make_dir(&path)
}

#[tauri::command]
fn fs_grep(root: String, query: String, max: Option<usize>) -> Vec<GrepHit> {
    fs_ops::grep(&root, &query, max.unwrap_or(80))
}

#[tauri::command]
fn fs_reveal(path: String) -> Result<(), String> {
    fs_ops::reveal_in_os(&path)
}

#[tauri::command]
fn history_save(workspace: String, file: String, content: String) -> Result<(), String> {
    fs_ops::save_snapshot(&workspace, &file, &content)
}

#[tauri::command]
fn history_list(workspace: String, file: String) -> Result<Vec<Snapshot>, String> {
    fs_ops::list_snapshots(&workspace, &file)
}

#[tauri::command]
fn history_read(path: String) -> Result<String, String> {
    fs_ops::read_snapshot(&path)
}

#[tauri::command]
fn fs_backlinks(workspace: String, file: String, max: Option<usize>) -> Vec<Backlink> {
    fs_ops::find_backlinks(&workspace, &file, max.unwrap_or(50))
}

#[tauri::command]
fn fs_trash_move(workspace: String, path: String) -> Result<(), String> {
    fs_ops::trash_move(&workspace, &path)
}

#[tauri::command]
fn fs_trash_list(workspace: String) -> Result<Vec<TrashItem>, String> {
    fs_ops::trash_list(&workspace)
}

#[tauri::command]
fn fs_trash_restore(workspace: String, stored: String) -> Result<String, String> {
    fs_ops::trash_restore(&workspace, &stored)
}

#[tauri::command]
fn fs_trash_purge(workspace: String, stored: Option<String>) -> Result<(), String> {
    fs_ops::trash_purge(&workspace, stored)
}

#[tauri::command]
async fn ai_chat(req: ChatRequest) -> Result<ChatResponse, String> {
    ai::chat(req).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            md_render,
            md_outline,
            fs_read_tree,
            fs_read_text,
            fs_write_text,
            fs_rename,
            fs_delete,
            fs_mkdir,
            fs_grep,
            fs_reveal,
            history_save,
            history_list,
            history_read,
            fs_backlinks,
            fs_trash_move,
            fs_trash_list,
            fs_trash_restore,
            fs_trash_purge,
            ai_chat,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
