//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use super::walker_io::atomic_write;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub path: String,
    pub name: String,
    /// 原始路径（恢复时写回）
    pub original: String,
    pub timestamp: i64,
    pub size: u64,
    pub is_dir: bool,
}

fn trash_dir(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join(".markio").join("trash")
}

fn ts_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn move_to_trash(src: &Path, dest: &Path) -> Result<(), String> {
    fs::rename(src, dest).map_err(|e| e.to_string())
}

fn restore_from_trash(stored: &Path, dest: &Path) -> Result<(), String> {
    fs::rename(stored, dest).map_err(|e| e.to_string())
}

fn trash_item_paths(
    dir: &Path,
    timestamp: i64,
    name: &str,
    is_dir: bool,
) -> Result<(String, PathBuf, PathBuf), String> {
    let ext = if is_dir { "dir" } else { "bin" };
    for attempt in 0..10_000 {
        let stem = if attempt == 0 {
            format!("{timestamp}__{name}")
        } else {
            format!("{timestamp}__{attempt}__{name}")
        };
        let stored = format!("{stem}.{ext}");
        let stored_path = dir.join(&stored);
        let meta_path = dir.join(format!("{stem}.meta.json"));
        if !stored_path.exists() && !meta_path.exists() {
            return Ok((stored, stored_path, meta_path));
        }
    }
    Err("回收站已有过多同名项目，请稍后再试".to_string())
}

pub fn trash_move(workspace: &str, file: &str) -> Result<(), String> {
    let src = PathBuf::from(file);
    if !src.exists() {
        return Err(format!("路径不存在：{file}"));
    }
    let dir = trash_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无效文件名".to_string())?;
    let ts = ts_now();
    let is_dir = src.is_dir();
    let kind = if is_dir { "dir" } else { "file" };
    let (stored, stored_path, meta_path) = trash_item_paths(&dir, ts, &name, is_dir)?;
    move_to_trash(&src, &stored_path)?;
    let meta = serde_json::json!({
        "original": src.to_string_lossy(),
        "name": name,
        "timestamp": ts,
        "stored": stored,
        "kind": kind,
    });
    if let Err(e) = atomic_write(&meta_path, &meta.to_string()) {
        let rollback = restore_from_trash(&stored_path, &src);
        return Err(match rollback {
            Ok(()) => format!("写回收站清单失败，已回滚：{e}"),
            Err(rollback_err) => {
                format!("写回收站清单失败：{e}；回滚失败：{rollback_err}")
            }
        });
    }
    Ok(())
}

pub fn trash_list(workspace: &str) -> Result<Vec<TrashItem>, String> {
    let dir = trash_dir(workspace);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<TrashItem> = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".meta.json") {
            continue;
        }
        let Ok(s) = fs::read_to_string(e.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else {
            continue;
        };
        let original = v
            .get("original")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let orig_name = v
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let ts = v.get("timestamp").and_then(|x| x.as_i64()).unwrap_or(0);
        let stored_name = v
            .get("stored")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{ts}__{orig_name}.bin"));
        let stored = dir.join(stored_name);
        let is_dir = v
            .get("kind")
            .and_then(|x| x.as_str())
            .map(|kind| kind == "dir")
            .unwrap_or_else(|| stored.is_dir());
        let size = stored.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(TrashItem {
            path: stored.to_string_lossy().to_string(),
            name: orig_name,
            original,
            timestamp: ts,
            size,
            is_dir,
        });
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

pub fn trash_restore(workspace: &str, stored: &str) -> Result<String, String> {
    let ws = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| format!("仓库路径无效：{e}"))?;
    let dir = trash_dir(workspace)
        .canonicalize()
        .map_err(|e| format!("回收站目录无效：{e}"))?;
    let stored_path = PathBuf::from(stored)
        .canonicalize()
        .map_err(|_| "回收站项目不存在".to_string())?;
    if !stored_path.starts_with(&dir) {
        return Err("拒绝恢复：回收站项目路径无效".to_string());
    }
    if !stored_path.exists() {
        return Err("回收站项目不存在".to_string());
    }
    // 找 meta
    let stem = stored_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let meta_path = dir.join(format!("{stem}.meta.json"));
    let s = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let original = v
        .get("original")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "丢失原始路径".to_string())?
        .to_string();
    let dest = PathBuf::from(&original);
    let parent = dest
        .parent()
        .ok_or_else(|| "原始路径没有父目录".to_string())?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|_| "原始目录不存在，请先恢复目录结构".to_string())?;
    let fname = dest
        .file_name()
        .ok_or_else(|| "原始路径文件名无效".to_string())?;
    let dest = parent_canon.join(fname);
    if !dest.starts_with(&ws) || dest.starts_with(ws.join(".markio")) {
        return Err("拒绝恢复：目标路径不在用户文件区".to_string());
    }
    if dest.exists() {
        return Err("原位置已存在同名项目".to_string());
    }
    restore_from_trash(&stored_path, &dest)?;
    let _ = fs::remove_file(meta_path);
    Ok(original)
}

pub fn trash_purge(workspace: &str, stored: Option<String>) -> Result<(), String> {
    let dir = trash_dir(workspace);
    if !dir.exists() {
        return Ok(());
    }
    let dir_canon = dir
        .canonicalize()
        .map_err(|e| format!("回收站目录无效：{e}"))?;
    if let Some(path) = stored {
        let p = PathBuf::from(&path)
            .canonicalize()
            .map_err(|_| "回收站项目不存在".to_string())?;
        if !p.starts_with(&dir_canon) || !p.exists() {
            return Err("拒绝删除：回收站项目路径无效".to_string());
        }
        if p.is_dir() {
            let _ = fs::remove_dir_all(&p);
        } else {
            let _ = fs::remove_file(&p);
        }
        // meta 也一起删
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = dir.join(format!("{stem}.meta.json"));
        if meta.exists() {
            let _ = fs::remove_file(meta);
        }
    } else {
        let _ = fs::remove_dir_all(&dir);
    }
    Ok(())
}

pub fn reveal_in_os(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-R", path])
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .args(["/select,", path])
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        use std::process::Command;
        let target = if p.is_dir() {
            p.clone()
        } else {
            p.parent().map(|x| x.to_path_buf()).unwrap_or(p)
        };
        Command::new("xdg-open")
            .arg(target)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

