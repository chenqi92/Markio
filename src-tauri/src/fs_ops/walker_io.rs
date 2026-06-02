//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::ignore::{is_markdown_name, is_under_nested_code_project, IgnoreRules};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub children: Option<Vec<FileEntry>>,
    pub truncated: bool,
}

pub(super) const MAX_DEPTH: usize = 8;
pub(super) const MAX_ENTRIES: usize = 8_000;
const MAX_DIR_CHILDREN: usize = 2_000;
const MAX_VISITED_ENTRIES: usize = 50_000;

pub(super) fn is_hidden(name: &str) -> bool {
    crate::ignore::is_hidden_name(name)
}

pub(super) fn is_markdown(name: &str) -> bool {
    is_markdown_name(name)
}

pub(super) fn ignored_by_rules(
    root: &Path,
    path: &Path,
    is_dir: bool,
    rules: &IgnoreRules,
) -> bool {
    if is_under_nested_code_project(root, path) {
        return true;
    }
    path.strip_prefix(root)
        .ok()
        .is_some_and(|rel| rules.is_ignored(rel, is_dir))
}

/// 当作"附件"看待的扩展名 —— 不在主文件树里、但放进侧边栏的「附件」分区
pub(super) fn attachment_kind(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next()?;
    match ext {
        "pdf" => Some("pdf"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "heic" | "avif" => {
            Some("image")
        }
        "svg" => Some("svg"),
        "mp4" | "mov" | "m4v" | "webm" | "avi" | "mkv" => Some("video"),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" => Some("audio"),
        "docx" | "doc" | "pages" => Some("word"),
        "xlsx" | "xls" | "numbers" | "csv" => Some("sheet"),
        "pptx" | "ppt" | "key" => Some("slides"),
        "zip" | "tar" | "gz" | "7z" | "rar" => Some("archive"),
        _ => None,
    }
}

pub(super) fn modified_ms(p: &Path) -> i64 {
    p.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct Walker {
    root: PathBuf,
    ignore: IgnoreRules,
    visited: usize,
    counted: usize,
    cap_hit: bool,
}

impl Walker {
    fn ignored(&self, path: &Path, is_dir: bool) -> bool {
        if is_under_nested_code_project(&self.root, path) {
            return true;
        }
        path.strip_prefix(&self.root)
            .ok()
            .is_some_and(|rel| self.ignore.is_ignored(rel, is_dir))
    }

    fn walk(&mut self, dir: &Path, depth: usize) -> Option<FileEntry> {
        if self.cap_hit {
            return None;
        }
        if depth > MAX_DEPTH {
            return Some(FileEntry {
                name: dir
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| dir.display().to_string()),
                path: dir.to_string_lossy().to_string(),
                is_dir: true,
                size: 0,
                modified: modified_ms(dir),
                children: Some(Vec::new()),
                truncated: true,
            });
        }

        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => {
                return Some(FileEntry {
                    name: dir
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| dir.display().to_string()),
                    path: dir.to_string_lossy().to_string(),
                    is_dir: true,
                    size: 0,
                    modified: modified_ms(dir),
                    children: Some(Vec::new()),
                    truncated: false,
                });
            }
        };

        let mut dirs: Vec<(PathBuf, String)> = Vec::new();
        let mut files: Vec<FileEntry> = Vec::new();

        for (local_count, entry) in entries.flatten().enumerate() {
            if self.visited >= MAX_VISITED_ENTRIES {
                self.cap_hit = true;
                break;
            }
            if local_count >= MAX_DIR_CHILDREN {
                break;
            }
            self.visited += 1;
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&name) {
                continue;
            }
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                // 安全起见，跳过符号链接，避免循环
                continue;
            }
            if self.ignored(&path, ft.is_dir()) {
                continue;
            }
            if ft.is_dir() {
                dirs.push((path, name));
            } else if ft.is_file() {
                if !is_markdown(&name) {
                    continue;
                }
                if self.counted >= MAX_ENTRIES {
                    self.cap_hit = true;
                    break;
                }
                self.counted += 1;
                let meta = entry.metadata().ok();
                files.push(FileEntry {
                    name: name.clone(),
                    path: path.to_string_lossy().to_string(),
                    is_dir: false,
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: modified_ms(&path),
                    children: None,
                    truncated: false,
                });
            }
        }

        // 递归子目录
        let mut child_dirs: Vec<FileEntry> = Vec::new();
        for (path, _name) in dirs {
            if self.cap_hit {
                break;
            }
            if let Some(child) = self.walk(&path, depth + 1) {
                // 剪枝：完全没有 markdown 后代的目录就丢掉，避免界面噪音
                if has_any_md(&child) {
                    child_dirs.push(child);
                }
            }
        }

        child_dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        let mut children = Vec::with_capacity(child_dirs.len() + files.len());
        children.extend(child_dirs);
        children.extend(files);

        Some(FileEntry {
            name: dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| dir.display().to_string()),
            path: dir.to_string_lossy().to_string(),
            is_dir: true,
            size: 0,
            modified: modified_ms(dir),
            children: Some(children),
            truncated: self.cap_hit,
        })
    }
}

fn has_any_md(entry: &FileEntry) -> bool {
    if !entry.is_dir {
        return true;
    }
    entry
        .children
        .as_ref()
        .map(|cs| cs.iter().any(has_any_md))
        .unwrap_or(false)
}

pub fn walk_tree(root_path: &str) -> Result<FileEntry, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("路径不存在：{root_path}"));
    }
    if !root.is_dir() {
        return Err(format!("不是文件夹：{root_path}"));
    }
    let mut w = Walker {
        root: root.clone(),
        ignore: IgnoreRules::load(&root),
        visited: 0,
        counted: 0,
        cap_hit: false,
    };
    let mut root_entry = w
        .walk(&root, 0)
        .ok_or_else(|| "无法扫描该文件夹".to_string())?;
    // 即使根目录没有 md，也保留显示（避免欢迎页又跳回空状态）
    if root_entry.children.is_none() {
        root_entry.children = Some(Vec::new());
    }
    Ok(root_entry)
}

pub fn read_dir_shallow(root_path: &str) -> Result<FileEntry, String> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("路径不存在：{root_path}"));
    }
    if !root.is_dir() {
        return Err(format!("不是文件夹：{root_path}"));
    }

    let entries = fs::read_dir(&root).map_err(|e| format!("无法读取目录：{e}"))?;
    let ignore = IgnoreRules::load(&root);
    let mut dirs: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();
    let mut truncated = false;

    for (local_count, entry) in entries.flatten().enumerate() {
        if local_count >= MAX_DIR_CHILDREN {
            truncated = true;
            break;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }

        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ignored_by_rules(&root, &path, ft.is_dir(), &ignore) {
            continue;
        }

        if ft.is_dir() {
            dirs.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                size: 0,
                modified: modified_ms(&path),
                children: None,
                truncated: false,
            });
        } else if ft.is_file() {
            if !is_markdown(&name) {
                continue;
            }
            if files.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let meta = entry.metadata().ok();
            files.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: modified_ms(&path),
                children: None,
                truncated: false,
            });
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let mut children = Vec::with_capacity(dirs.len() + files.len());
    children.extend(dirs);
    children.extend(files);

    Ok(FileEntry {
        name: root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| root.display().to_string()),
        path: root.to_string_lossy().to_string(),
        is_dir: true,
        size: 0,
        modified: modified_ms(&root),
        children: Some(children),
        truncated,
    })
}

pub fn read_text(path: &str) -> Result<String, String> {
    read_text_path(Path::new(path))
}

pub fn read_text_path(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string());
    }
    if let Ok(s) = std::str::from_utf8(&bytes) {
        return Ok(s.to_string());
    }
    let (cow, _, _) = encoding_rs::UTF_8.decode(&bytes);
    Ok(cow.into_owned())
}

#[allow(dead_code)]
pub fn write_text(path: &str, content: &str) -> Result<(), String> {
    atomic_write(Path::new(path), content)
}

/// 原子写：写到 .markio-tmp-<pid>-<ts> → fsync → rename
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| "路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let ts = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let pid = std::process::id();
    let tmp = parent.join(format!(".markio-tmp-{pid}-{ts}"));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(content.as_bytes()).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })?;
        // fsync 把内容真正落盘；某些 fs 不支持就忽略
        let _ = f.sync_all();
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

/// 创建：若目标文件已存在直接返回 ALREADY_EXISTS:<path>，不覆盖
pub fn create_new(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| "路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut f = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!("ALREADY_EXISTS:{}", path.display()))
        }
        Err(e) => return Err(e.to_string()),
    };
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    let _ = f.sync_all();
    Ok(())
}

pub fn rename(from: &str, to: &str) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub fn delete(path: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

pub fn make_dir(path: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}
