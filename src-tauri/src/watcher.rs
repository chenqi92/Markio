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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

type DebouncerHandle = Debouncer<notify::RecommendedWatcher>;

static WATCHERS: OnceLock<Mutex<HashMap<PathBuf, DebouncerHandle>>> = OnceLock::new();

fn map() -> &'static Mutex<HashMap<PathBuf, DebouncerHandle>> {
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Default, Clone, Debug)]
struct WatcherStats {
    events_total: u64,
    emit_failures: u64,
    backend_errors: u64,
    last_error: Option<String>,
    last_event_at: Option<u64>,
}

static STATS: OnceLock<Mutex<HashMap<PathBuf, WatcherStats>>> = OnceLock::new();

fn stats() -> &'static Mutex<HashMap<PathBuf, WatcherStats>> {
    STATS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_stats<F: FnOnce(&mut WatcherStats)>(ws: &Path, f: F) {
    if let Ok(mut map) = stats().lock() {
        let entry = map.entry(ws.to_path_buf()).or_default();
        f(entry);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherHealthDto {
    pub workspace: String,
    pub running: bool,
    pub events_total: u64,
    pub emit_failures: u64,
    pub backend_errors: u64,
    pub last_error: Option<String>,
    pub last_event_at: Option<u64>,
}

/// 给前端的健康快照。`running` 反映 watcher 是否还在监听；
/// 长跑场景下用户可能挂起 / 系统休眠 / FSEvents 队列爆——前端可定期拉取，
/// 若 `backend_errors` 在涨或 `last_event_at` 远落后于本地编辑节奏可触发重建。
pub fn health_snapshot() -> Vec<WatcherHealthDto> {
    let running_set: Vec<PathBuf> = map()
        .lock()
        .ok()
        .map(|g| g.keys().cloned().collect())
        .unwrap_or_default();
    let stats_map: HashMap<PathBuf, WatcherStats> =
        stats().lock().ok().map(|g| g.clone()).unwrap_or_default();
    let mut keys: Vec<PathBuf> = running_set.to_vec();
    for k in stats_map.keys() {
        if !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    keys.into_iter()
        .map(|ws| {
            let s = stats_map.get(&ws).cloned().unwrap_or_default();
            WatcherHealthDto {
                workspace: ws.to_string_lossy().to_string(),
                running: running_set.contains(&ws),
                events_total: s.events_total,
                emit_failures: s.emit_failures,
                backend_errors: s.backend_errors,
                last_error: s.last_error,
                last_event_at: s.last_event_at,
            }
        })
        .collect()
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

    let ws_for_stats = ws.clone();
    let mut debouncer: DebouncerHandle = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| {
            let events = match res {
                Ok(events) => events,
                Err(e) => {
                    let msg = format!("{e:?}");
                    eprintln!("[watcher] {msg}");
                    with_stats(&ws_for_stats, |s| {
                        s.backend_errors += 1;
                        s.last_error = Some(msg);
                    });
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
                let emit_res = app_for_cb.emit(
                    "fs-changed",
                    FsChangedPayload {
                        workspace: workspace_str.clone(),
                        path: path.to_string_lossy().to_string(),
                        kind,
                    },
                );
                with_stats(&ws_for_stats, |s| {
                    s.events_total += 1;
                    s.last_event_at = Some(now_ms());
                    if let Err(e) = &emit_res {
                        s.emit_failures += 1;
                        s.last_error = Some(format!("emit: {e}"));
                    }
                });
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
