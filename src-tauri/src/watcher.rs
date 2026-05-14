// 工作仓库文件监听
//
// 每个已注册 workspace 一个 watcher：
//   * 500ms debounce
//   * .md 改动 → emit("fs-changed", { workspace, path, kind })
//   * 删除 → emit("fs-removed", { workspace, path })
//   * 默认忽略 `.markio/`、`.git/`、`node_modules/`、隐藏目录
//
// 增量重索引由前端在收到事件后调用 `rag_reindex_file` / `rag_remove_file` 决策；
// 后端这层只做事件分发，避免双向耦合。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

type DebouncerHandle = Debouncer<notify::RecommendedWatcher>;

static WATCHERS: OnceLock<Mutex<HashMap<PathBuf, DebouncerHandle>>> = OnceLock::new();

fn map() -> &'static Mutex<HashMap<PathBuf, DebouncerHandle>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    workspace: String,
    path: String,
    /// "modified" / "created" / "removed"
    kind: &'static str,
}

fn should_ignore(rela: &Path) -> bool {
    for comp in rela.components() {
        let s = comp.as_os_str().to_string_lossy();
        let s = s.as_ref();
        if s.starts_with('.') {
            // 命中 .markio / .git / .DS_Store / dotfiles 都直接跳过
            return true;
        }
        if matches!(
            s,
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "coverage"
                | "__pycache__"
                | ".turbo"
                | ".next"
                | ".nuxt"
        ) {
            return true;
        }
    }
    false
}

fn is_text_like(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "txt"
    )
}

pub fn watch(app: AppHandle, workspace: PathBuf) -> Result<(), String> {
    let ws = workspace.clone();
    {
        let guard = map().lock().map_err(|e| format!("watcher lock: {e}"))?;
        if guard.contains_key(&ws) {
            return Ok(()); // 已经在监听
        }
    }
    let workspace_str = ws.to_string_lossy().to_string();
    let ws_for_cb = ws.clone();
    let app_for_cb = app.clone();

    let mut debouncer: DebouncerHandle = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| {
            let events = match res {
                Ok(events) => events,
                Err(e) => {
                    eprintln!("[watcher] {e:?}");
                    return;
                }
            };
            for ev in events {
                let path = ev.path;
                let Ok(rela) = path.strip_prefix(&ws_for_cb) else {
                    continue;
                };
                if should_ignore(rela) {
                    continue;
                }
                if !path.is_dir() && !is_text_like(&path) {
                    continue;
                }
                let kind = if path.exists() { "modified" } else { "removed" };
                let _ = app_for_cb.emit(
                    "fs-changed",
                    FsChangedPayload {
                        workspace: workspace_str.clone(),
                        path: path.to_string_lossy().to_string(),
                        kind,
                    },
                );
            }
        },
    )
    .map_err(|e| format!("初始化 watcher 失败：{e}"))?;

    debouncer
        .watcher()
        .watch(&ws, RecursiveMode::Recursive)
        .map_err(|e| format!("注册监听失败：{e}"))?;

    let mut guard = map().lock().map_err(|e| format!("watcher lock: {e}"))?;
    guard.insert(ws, debouncer);
    Ok(())
}

pub fn unwatch(workspace: &Path) {
    if let Ok(mut guard) = map().lock() {
        guard.remove(workspace);
    }
}
