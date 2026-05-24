//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use super::walker_io::read_text;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub name: String,
    pub timestamp: i64,
    pub size: u64,
}

fn snapshot_dir(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join(".markio").join("history")
}

/// 用相对路径做 key，把 / 替换为 ¦，避免目录嵌套。
/// 不属于 workspace 的 file 直接拒绝，杜绝历史快照串库 / 串文件。
fn snapshot_key(file: &Path, workspace: &Path) -> Result<String, String> {
    let rel = file
        .strip_prefix(workspace)
        .map_err(|_| "拒绝历史快照：文件不在所选仓库下".to_string())?;
    if rel.as_os_str().is_empty() {
        return Err("拒绝历史快照：路径解析为仓库根目录".to_string());
    }
    Ok(rel.to_string_lossy().replace(['/', '\\'], "¦"))
}

pub fn save_snapshot(workspace: &str, file: &str, content: &str) -> Result<(), String> {
    let ws_path = PathBuf::from(workspace);
    let file_path = PathBuf::from(file);
    let key = snapshot_key(&file_path, &ws_path)?;
    let dir = snapshot_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = chrono::Utc::now().timestamp_millis();
    let snap_name = format!("{key}__{ts}.md");
    let snap_path = dir.join(snap_name);
    fs::write(&snap_path, content).map_err(|e| e.to_string())?;
    // 同一文件最多保留 30 份
    prune_snapshots(&dir, &key, 30)?;
    Ok(())
}

fn prune_snapshots(dir: &Path, key: &str, max: usize) -> Result<(), String> {
    let prefix = format!("{key}__");
    let mut entries: Vec<(i64, PathBuf)> = Vec::new();
    if let Ok(read) = fs::read_dir(dir) {
        for e in read.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(&prefix) || !name.ends_with(".md") {
                continue;
            }
            let ts_str = name.trim_start_matches(&prefix).trim_end_matches(".md");
            if let Ok(ts) = ts_str.parse::<i64>() {
                entries.push((ts, e.path()));
            }
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in entries.into_iter().skip(max) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

pub fn list_snapshots(workspace: &str, file: &str) -> Result<Vec<Snapshot>, String> {
    let ws_path = PathBuf::from(workspace);
    let file_path = PathBuf::from(file);
    let dir = snapshot_dir(workspace);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let key = snapshot_key(&file_path, &ws_path)?;
    let prefix = format!("{key}__");
    let mut out: Vec<Snapshot> = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) || !name.ends_with(".md") {
            continue;
        }
        let ts_str = name.trim_start_matches(&prefix).trim_end_matches(".md");
        let ts: i64 = ts_str.parse().unwrap_or(0);
        let meta = e.metadata().ok();
        out.push(Snapshot {
            path: e.path().to_string_lossy().to_string(),
            name: name.clone(),
            timestamp: ts,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

pub fn read_snapshot(path: &str) -> Result<String, String> {
    read_text(path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub snapshot_path: String,
    pub source_path: String,
    pub source_name: String,
    pub timestamp: i64,
    pub size: u64,
}

/// 扫描整个 workspace 的 .markio/history/，把所有快照按时间倒序返回。
/// 文件名形如 `{key}__{ts}.md`，key 是相对路径把 `/` 换成 `¦`。
pub fn list_all_snapshots(workspace: &str) -> Result<Vec<TimelineEntry>, String> {
    let dir = snapshot_dir(workspace);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let ws_path = PathBuf::from(workspace);
    let mut out: Vec<TimelineEntry> = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            continue;
        }
        let stem = name.trim_end_matches(".md");
        let Some((key, ts_str)) = stem.rsplit_once("__") else {
            continue;
        };
        let Ok(ts) = ts_str.parse::<i64>() else {
            continue;
        };
        let rel = key.replace('¦', std::path::MAIN_SEPARATOR_STR);
        let source_path = ws_path.join(&rel).to_string_lossy().to_string();
        let source_name = Path::new(&rel)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.clone());
        let size = e.metadata().ok().map(|m| m.len()).unwrap_or(0);
        out.push(TimelineEntry {
            snapshot_path: e.path().to_string_lossy().to_string(),
            source_path,
            source_name,
            timestamp: ts,
            size,
        });
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

