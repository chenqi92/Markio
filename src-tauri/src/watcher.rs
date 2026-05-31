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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::ignore::{is_text_note_path, is_under_nested_code_project, IgnoreRules};

type DebouncerHandle = Debouncer<notify::RecommendedWatcher>;

static WATCHERS: OnceLock<Mutex<HashMap<PathBuf, DebouncerHandle>>> = OnceLock::new();
const RECURSIVE_WATCH_ENTRY_LIMIT: usize = 20_000;
const SELECTIVE_WATCH_DIR_LIMIT: usize = 5_000;

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

fn raw_entry_count_exceeds(root: &Path, limit: usize) -> bool {
    let mut count = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            count += 1;
            if count > limit {
                return true;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() && !ft.is_symlink() {
                stack.push(entry.path());
            }
        }
    }
    false
}

fn selective_watch_dirs(root: &Path, ignore: &IgnoreRules) -> (Vec<PathBuf>, usize) {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped_after_limit = 0usize;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        if dirs.len() < SELECTIVE_WATCH_DIR_LIMIT {
            dirs.push(dir.clone());
        } else {
            skipped_after_limit += 1;
            continue;
        }

        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(rela) = path.strip_prefix(root) else {
                continue;
            };
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ignore.is_ignored(rela, ft.is_dir()) {
                continue;
            }
            if is_under_nested_code_project(root, &path) {
                continue;
            }
            if ft.is_dir() && !ft.is_symlink() {
                stack.push(path);
            }
        }
    }

    (dirs, skipped_after_limit)
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
    let ignore = IgnoreRules::load(&ws);
    let ws_for_cb = ws.clone();
    let app_for_cb = app.clone();
    let ignore_for_cb = ignore.clone();

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
                if ignore_for_cb.is_ignored(rela, path.is_dir()) {
                    continue;
                }
                if is_under_nested_code_project(&ws_for_cb, &path) {
                    continue;
                }
                if !path.is_dir() && !is_text_note_path(&path) {
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

    if raw_entry_count_exceeds(&ws, RECURSIVE_WATCH_ENTRY_LIMIT) {
        let (dirs, skipped_after_limit) = selective_watch_dirs(&ws, &ignore);
        for (idx, dir) in dirs.iter().enumerate() {
            let result = debouncer.watcher().watch(dir, RecursiveMode::NonRecursive);
            if let Err(e) = result {
                let msg = format!("注册选择性监听失败 {}：{e}", dir.display());
                if idx == 0 {
                    return Err(msg);
                }
                with_stats(&ws, |s| {
                    s.backend_errors += 1;
                    s.last_error = Some(msg);
                });
            }
        }
        with_stats(&ws, |s| {
            s.last_error = Some(format!(
                "大目录已启用选择性监听：{} 个目录，跳过 node_modules/target/隐藏目录{}",
                dirs.len(),
                if skipped_after_limit > 0 {
                    format!("，另有 {skipped_after_limit} 个目录超过监听上限")
                } else {
                    String::new()
                }
            ));
        });
    } else {
        debouncer
            .watcher()
            .watch(&ws, RecursiveMode::Recursive)
            .map_err(|e| format!("注册监听失败：{e}"))?;
    }

    let mut guard = map().lock().map_err(|e| format!("watcher lock: {e}"))?;
    guard.insert(ws, debouncer);
    Ok(())
}

pub fn unwatch(workspace: &Path) {
    if let Ok(mut guard) = map().lock() {
        guard.remove(workspace);
    }
}

#[cfg(test)]
mod tests {
    use super::{raw_entry_count_exceeds, selective_watch_dirs};
    use crate::ignore::IgnoreRules;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "markio-watcher-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    #[test]
    fn raw_entry_count_detects_large_tree() {
        let root = temp_dir("large");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "").unwrap();
        std::fs::write(root.join("b.md"), "").unwrap();

        assert!(raw_entry_count_exceeds(&root, 1));
        assert!(!raw_entry_count_exceeds(&root, 10));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn selective_watch_skips_dependency_and_hidden_dirs() {
        let root = temp_dir("selective");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".markio/history")).unwrap();
        std::fs::create_dir_all(root.join("FastBee-master/src")).unwrap();
        std::fs::write(root.join("FastBee-master/pom.xml"), "").unwrap();

        let ignore = IgnoreRules::load(&root);
        let (dirs, skipped) = selective_watch_dirs(&root, &ignore);

        let names = dirs
            .iter()
            .map(|p| {
                p.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect::<Vec<_>>();
        assert_eq!(skipped, 0);
        assert!(names.iter().any(|n| n.is_empty()));
        assert!(names.iter().any(|n| n == "notes"));
        assert!(!names.iter().any(|n| n.starts_with("node_modules")));
        assert!(!names.iter().any(|n| n.starts_with(".markio")));
        assert!(!names.iter().any(|n| n.starts_with("FastBee-master")));

        let _ = std::fs::remove_dir_all(root);
    }
}
