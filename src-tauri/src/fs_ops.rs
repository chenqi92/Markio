use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

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

const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 8_000;
const MAX_DIR_CHILDREN: usize = 2_000;
const MAX_VISITED_ENTRIES: usize = 50_000;

/// 这些目录一旦遇到就完整跳过，不再下钻。
/// 目的：避免 walker 卡在 node_modules / cargo target / build cache 等海量目录里。
///
/// Windows / macOS 大小写不敏感文件系统上 "Node_Modules" 也算 "node_modules"，
/// 这里做小写归一化。
fn is_skip_dir(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    matches!(
        n.as_str(),
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | ".turbo"
            | ".cache"
            | ".parcel-cache"
            | ".venv"
            | "venv"
            | "env"
            | "__pycache__"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".tox"
            | ".gradle"
            | ".idea"
            | ".vscode"
            | ".vs"
            | "derivedata"
            | "pods"
            | ".bundle"
            | ".terraform"
            | "vendor"
    )
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}

/// 当作"附件"看待的扩展名 —— 不在主文件树里、但放进侧边栏的「附件」分区
fn attachment_kind(name: &str) -> Option<&'static str> {
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

fn modified_ms(p: &Path) -> i64 {
    p.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct Walker {
    visited: usize,
    counted: usize,
    cap_hit: bool,
}

impl Walker {
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
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
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

        if ft.is_dir() {
            if is_skip_dir(&name) {
                continue;
            }
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
pub struct Backlink {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub preview: String,
}

/// 扫描整个 workspace 找所有 `[[needle]]`（按文件名 stem 匹配）。
pub fn find_backlinks(workspace: &str, file: &str, max: usize) -> Vec<Backlink> {
    let stem = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if stem.is_empty() {
        return Vec::new();
    }
    let needle = stem.to_lowercase();
    let mut out: Vec<Backlink> = Vec::new();

    fn visit(
        dir: &Path,
        depth: usize,
        needle: &str,
        skip: &str,
        out: &mut Vec<Backlink>,
        max: usize,
    ) {
        if out.len() >= max || depth > MAX_DEPTH {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if out.len() >= max {
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
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                visit(&path, depth + 1, needle, skip, out, max);
            } else if ft.is_file() && is_markdown(&name) {
                // 跳过自身
                if path.to_string_lossy() == skip {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > MAX_GREP_FILE_SIZE {
                        continue;
                    }
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                let lower = content.to_lowercase();
                let key = format!("[[{needle}");
                if !lower.contains(&key) {
                    continue;
                }
                for (i, line) in content.lines().enumerate() {
                    let lline = line.to_lowercase();
                    if !lline.contains(&key) {
                        continue;
                    }
                    let preview = if line.chars().count() > 160 {
                        line.chars().take(160).collect::<String>() + "…"
                    } else {
                        line.to_string()
                    };
                    out.push(Backlink {
                        path: path.to_string_lossy().to_string(),
                        name: name.clone(),
                        line: (i + 1) as u32,
                        preview,
                    });
                    break; // 一个文件最多 1 条
                }
            }
        }
    }

    visit(Path::new(workspace), 0, &needle, file, &mut out, max);
    out
}

/// 是否是 Unicode 词字符（字母 / 数字 / 下划线 / CJK）。
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 在 line 中找 needle 的"未链接"出现：
/// 排除已经被 `[[...]]` 包围的位置。
/// 对 ASCII needle 强制词边界；CJK needle 不强制（中文无分词空格）。
fn line_has_unlinked(line_lower: &str, needle: &str) -> bool {
    let ascii_needle = needle.chars().all(|c| c.is_ascii());
    let bytes = line_lower.as_bytes();
    let nlen = needle.len();
    let mut start = 0;
    while let Some(pos) = line_lower[start..].find(needle) {
        let abs = start + pos;
        let inside_wiki = line_lower[..abs].ends_with("[[");
        let blocked = if ascii_needle {
            let before_is_word = abs > 0
                && line_lower[..abs]
                    .chars()
                    .last()
                    .map(is_word_char)
                    .unwrap_or(false);
            let after_idx = abs + nlen;
            let after_is_word = after_idx < bytes.len()
                && line_lower[after_idx..]
                    .chars()
                    .next()
                    .map(is_word_char)
                    .unwrap_or(false);
            before_is_word || after_is_word
        } else {
            false
        };
        if !inside_wiki && !blocked {
            return true;
        }
        start = abs + nlen.max(1);
        if start >= line_lower.len() {
            break;
        }
    }
    false
}

/// 扫描整个 workspace 找正文中"裸出现笔记标题"的未链接提及。
pub fn find_mentions(workspace: &str, file: &str, max: usize) -> Vec<Backlink> {
    let stem = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if stem.len() < 2 {
        return Vec::new();
    }
    let needle = stem.to_lowercase();
    let mut out: Vec<Backlink> = Vec::new();

    fn visit(
        dir: &Path,
        depth: usize,
        needle: &str,
        skip: &str,
        out: &mut Vec<Backlink>,
        max: usize,
    ) {
        if out.len() >= max || depth > MAX_DEPTH {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if out.len() >= max {
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
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                visit(&path, depth + 1, needle, skip, out, max);
            } else if ft.is_file() && is_markdown(&name) {
                if path.to_string_lossy() == skip {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > MAX_GREP_FILE_SIZE {
                        continue;
                    }
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                let lower = content.to_lowercase();
                if !lower.contains(needle) {
                    continue;
                }
                for (i, line) in content.lines().enumerate() {
                    let lline = line.to_lowercase();
                    if !line_has_unlinked(&lline, needle) {
                        continue;
                    }
                    let preview = if line.chars().count() > 160 {
                        line.chars().take(160).collect::<String>() + "…"
                    } else {
                        line.to_string()
                    };
                    out.push(Backlink {
                        path: path.to_string_lossy().to_string(),
                        name: name.clone(),
                        line: (i + 1) as u32,
                        preview,
                    });
                    break;
                }
            }
        }
    }

    visit(Path::new(workspace), 0, &needle, file, &mut out, max);
    out
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTokens {
    pub tags: Vec<String>,
    pub mentions: Vec<String>,
    pub files: Vec<String>,
}

/// 扫描整个 workspace 抽取 #tag / @mention / 文件名 stem，供 Autocomplete 全 vault 使用。
pub fn index_tokens(workspace: &str) -> VaultTokens {
    use std::collections::BTreeSet;
    let mut tags: BTreeSet<String> = BTreeSet::new();
    let mut mentions: BTreeSet<String> = BTreeSet::new();
    let mut files: BTreeSet<String> = BTreeSet::new();

    fn visit(
        dir: &Path,
        depth: usize,
        tags: &mut BTreeSet<String>,
        mentions: &mut BTreeSet<String>,
        files: &mut BTreeSet<String>,
    ) {
        if depth > MAX_DEPTH {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
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
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                visit(&path, depth + 1, tags, mentions, files);
            } else if ft.is_file() && is_markdown(&name) {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if !stem.is_empty() {
                    files.insert(stem);
                }
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > MAX_GREP_FILE_SIZE {
                        continue;
                    }
                }
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                extract_tokens_into(&content, tags, mentions);
                if tags.len() + mentions.len() + files.len() > 5_000 {
                    return;
                }
            }
        }
    }

    visit(
        Path::new(workspace),
        0,
        &mut tags,
        &mut mentions,
        &mut files,
    );

    VaultTokens {
        tags: tags.into_iter().collect(),
        mentions: mentions.into_iter().collect(),
        files: files.into_iter().collect(),
    }
}

fn extract_tokens_into(
    content: &str,
    tags: &mut std::collections::BTreeSet<String>,
    mentions: &mut std::collections::BTreeSet<String>,
) {
    let mut chars = content.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c != '#' && c != '@' {
            continue;
        }
        // 必须在词边界或行首
        if i > 0 {
            let prev = content[..i].chars().last();
            if prev.map(is_word_char).unwrap_or(false) {
                continue;
            }
        }
        // 收集后续 1..=64 个词字符
        let mut end = i + c.len_utf8();
        let rest = &content[end..];
        let mut count = 0;
        for ch in rest.chars() {
            if is_word_char(ch) || ch == '-' {
                end += ch.len_utf8();
                count += 1;
                if count >= 64 {
                    break;
                }
            } else {
                break;
            }
        }
        if count == 0 {
            continue;
        }
        let token = content[i + c.len_utf8()..end].to_string();
        if c == '#' {
            tags.insert(token);
        } else {
            mentions.insert(token);
        }
        // 让外层迭代继续从 end 之后
        while let Some(&(j, _)) = chars.peek() {
            if j < end {
                chars.next();
            } else {
                break;
            }
        }
    }
}

// ─── 持久化 vault index ─────────────────────────────────────────────
//
// 比 `index_tokens` 多带文件路径 / mtime / 大小，并把每个文件抽出的
// tags / mentions 一并存下来。下次启动时按 mtime diff 只重读改动过的
// 文件，未改动的复用旧记录。
//
// 落盘到 `<workspace>/.markio/index.json`，CommandPalette / Autocomplete
// 直接从这份内存中的 index 读"全 vault 文件列表"，不再依赖懒加载的 UI 树。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub path: String,
    pub name: String,
    pub stem: String,
    pub mtime: i64,
    pub size: u64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndex {
    pub files: Vec<VaultFile>,
    pub tags: Vec<String>,
    pub mentions: Vec<String>,
    pub scanned_at: i64,
}

const VAULT_INDEX_SCHEMA: u32 = 1;
const VAULT_INDEX_MAX_FILES: usize = 50_000;
const VAULT_INDEX_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultIndexEnvelope {
    schema: u32,
    #[serde(flatten)]
    index: VaultIndex,
}

fn vault_index_path(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join(".markio").join("index.json")
}

pub fn vault_index_load(workspace: &str) -> Option<VaultIndex> {
    let p = vault_index_path(workspace);
    if !p.exists() {
        return None;
    }
    let text = fs::read_to_string(&p).ok()?;
    let env: VaultIndexEnvelope = serde_json::from_str(&text).ok()?;
    if env.schema != VAULT_INDEX_SCHEMA {
        return None;
    }
    Some(env.index)
}

pub fn vault_index_save(workspace: &str, index: &VaultIndex) -> Result<(), String> {
    let p = vault_index_path(workspace);
    let parent = p.parent().ok_or_else(|| "无效 index 路径".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let env = VaultIndexEnvelope {
        schema: VAULT_INDEX_SCHEMA,
        index: index.clone(),
    };
    let body = serde_json::to_string(&env).map_err(|e| e.to_string())?;
    atomic_write(&p, &body)
}

/// 全 vault 扫描 + 抽 tag / mention，可选地用 `prev` 的 mtime 做 diff
/// 复用未改动文件的 token，避免重新读盘。
pub fn build_vault_index(workspace: &str, prev: Option<&VaultIndex>) -> VaultIndex {
    use std::collections::BTreeSet;

    let prev_by_path: HashMap<String, &VaultFile> = prev
        .map(|p| p.files.iter().map(|f| (f.path.clone(), f)).collect())
        .unwrap_or_default();

    let mut files: Vec<VaultFile> = Vec::new();
    let mut tags: BTreeSet<String> = BTreeSet::new();
    let mut mentions: BTreeSet<String> = BTreeSet::new();

    fn visit(
        dir: &Path,
        depth: usize,
        prev_by_path: &HashMap<String, &VaultFile>,
        files: &mut Vec<VaultFile>,
        tags: &mut std::collections::BTreeSet<String>,
        mentions: &mut std::collections::BTreeSet<String>,
    ) {
        if depth > MAX_DEPTH || files.len() >= VAULT_INDEX_MAX_FILES {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                // 桌面端常见：用户把 ~/Downloads 加成仓库后子目录没有读权限。
                // 之前静默跳过会让人误以为"索引建好了"——这里至少留 trace。
                eprintln!("[vault-index] 跳过目录 {}：{e}", dir.display());
                return;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[vault-index] 跳过 entry @ {}：{e}", dir.display());
                    continue;
                }
            };
            if files.len() >= VAULT_INDEX_MAX_FILES {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&name) {
                continue;
            }
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[vault-index] file_type 失败 {}：{e}", path.display());
                    continue;
                }
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                visit(&path, depth + 1, prev_by_path, files, tags, mentions);
            } else if ft.is_file() && is_markdown(&name) {
                let stem = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let path_str = path.to_string_lossy().to_string();
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let mtime = modified_ms(&path);

                let (file_tags, file_mentions) = if let Some(old) = prev_by_path.get(&path_str) {
                    if old.mtime == mtime && old.size == size {
                        (old.tags.clone(), old.mentions.clone())
                    } else {
                        extract_file_tokens(&path, size)
                    }
                } else {
                    extract_file_tokens(&path, size)
                };

                for t in &file_tags {
                    tags.insert(t.clone());
                }
                for m in &file_mentions {
                    mentions.insert(m.clone());
                }

                files.push(VaultFile {
                    path: path_str,
                    name,
                    stem,
                    mtime,
                    size,
                    tags: file_tags,
                    mentions: file_mentions,
                });
            }
        }
    }

    visit(
        Path::new(workspace),
        0,
        &prev_by_path,
        &mut files,
        &mut tags,
        &mut mentions,
    );

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    VaultIndex {
        files,
        tags: tags.into_iter().collect(),
        mentions: mentions.into_iter().collect(),
        scanned_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn extract_file_tokens(path: &Path, size: u64) -> (Vec<String>, Vec<String>) {
    use std::collections::BTreeSet;
    if size > VAULT_INDEX_MAX_FILE_BYTES {
        return (Vec::new(), Vec::new());
    }
    let Ok(content) = fs::read_to_string(path) else {
        return (Vec::new(), Vec::new());
    };
    let mut tags: BTreeSet<String> = BTreeSet::new();
    let mut mentions: BTreeSet<String> = BTreeSet::new();
    extract_tokens_into(&content, &mut tags, &mut mentions);
    (
        tags.into_iter().collect(),
        mentions.into_iter().collect(),
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub path: String,
    pub name: String,
    /// 原始路径（恢复时写回）
    pub original: String,
    pub timestamp: i64,
    pub size: u64,
}

fn trash_dir(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join(".markio").join("trash")
}

fn ts_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn trash_move(workspace: &str, file: &str) -> Result<(), String> {
    let src = PathBuf::from(file);
    if !src.exists() {
        return Err(format!("文件不存在：{file}"));
    }
    let dir = trash_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无效文件名".to_string())?;
    let ts = ts_now();
    let stored = format!("{ts}__{name}.bin");
    let meta_path = dir.join(format!("{ts}__{name}.meta.json"));
    fs::rename(&src, dir.join(&stored))
        .or_else(|_| {
            // 跨设备 rename 失败时退化为 copy + remove
            fs::copy(&src, dir.join(&stored))
                .map(|_| ())
                .and_then(|_| fs::remove_file(&src).map(|_| ()))
        })
        .map_err(|e| e.to_string())?;
    let meta = serde_json::json!({
        "original": src.to_string_lossy(),
        "name": name,
        "timestamp": ts,
    });
    fs::write(&meta_path, meta.to_string()).map_err(|e| e.to_string())?;
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
        let stored = dir.join(format!("{ts}__{orig_name}.bin"));
        let size = stored.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(TrashItem {
            path: stored.to_string_lossy().to_string(),
            name: orig_name,
            original,
            timestamp: ts,
            size,
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
    if !stored_path.exists() || !stored_path.is_file() {
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
        return Err("原位置已存在同名文件".to_string());
    }
    fs::rename(&stored_path, &dest)
        .or_else(|_| {
            fs::copy(&stored_path, &dest)
                .map(|_| ())
                .and_then(|_| fs::remove_file(&stored_path).map(|_| ()))
        })
        .map_err(|e| e.to_string())?;
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
        if !p.starts_with(&dir_canon) || !p.is_file() {
            return Err("拒绝删除：回收站项目路径无效".to_string());
        }
        let _ = fs::remove_file(&p);
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
        return Ok(());
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub preview: String,
}

const MAX_GREP_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
const MAX_GREP_FILES: usize = 3_000;

/// 简易 grep：扫描根目录下所有 markdown 文件，找文件名或文件内容里的 needle。
/// 为 AI 上下文挖周边 N 行（默认 ±3）。命中文件名时会取整篇前 1000 字。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContext {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    /// "pdf" / "image" / "svg" / "video" / "audio" / "word" / "sheet" / "slides" / "archive"
    pub kind: String,
}

/// 平铺扫整个 workspace 里的非 markdown 附件文件，按修改时间倒序。
pub fn list_attachments(root: &str, max: usize) -> Vec<Attachment> {
    let mut out: Vec<Attachment> = Vec::new();

    fn visit(dir: &Path, depth: usize, out: &mut Vec<Attachment>, max: usize) {
        if out.len() >= max || depth > MAX_DEPTH {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[list-attachments] 跳过目录 {}：{e}", dir.display());
                return;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[list-attachments] 跳过 entry @ {}：{e}", dir.display());
                    continue;
                }
            };
            if out.len() >= max {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&name) {
                continue;
            }
            let path = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[list-attachments] file_type 失败 {}：{e}", path.display());
                    continue;
                }
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                visit(&path, depth + 1, out, max);
            } else if ft.is_file() {
                let Some(kind) = attachment_kind(&name) else {
                    continue;
                };
                let meta = entry.metadata().ok();
                out.push(Attachment {
                    path: path.to_string_lossy().to_string(),
                    name: name.clone(),
                    size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified: modified_ms(&path),
                    kind: kind.to_string(),
                });
            }
        }
    }

    visit(Path::new(root), 0, &mut out, max);
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

pub fn retrieve_context(root: &str, query: &str, k: usize) -> Vec<AiContext> {
    let hits = grep(root, query, k.max(1));
    let mut out: Vec<AiContext> = Vec::with_capacity(hits.len());
    for h in hits {
        let content = match std::fs::read_to_string(&h.path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let snippet = if h.line == 0 {
            // 文件名命中：取整篇前 1000 字
            let n = content.chars().count().min(1000);
            content.chars().take(n).collect::<String>()
        } else {
            let lines: Vec<&str> = content.lines().collect();
            let idx = (h.line as usize)
                .saturating_sub(1)
                .min(lines.len().saturating_sub(1));
            let from = idx.saturating_sub(3);
            let to = (idx + 4).min(lines.len());
            lines[from..to].join("\n")
        };
        out.push(AiContext {
            path: h.path,
            name: h.name,
            line: h.line,
            snippet,
        });
    }
    out
}

pub fn grep(root: &str, query: &str, max_results: usize) -> Vec<GrepHit> {
    if query.is_empty() {
        return Vec::new();
    }
    let needle = query.to_lowercase();
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut counted = 0usize;

    fn visit(
        dir: &Path,
        depth: usize,
        needle: &str,
        hits: &mut Vec<GrepHit>,
        counted: &mut usize,
        max_results: usize,
    ) {
        if hits.len() >= max_results || depth > MAX_DEPTH || *counted > MAX_ENTRIES {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if hits.len() >= max_results {
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
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                visit(&path, depth + 1, needle, hits, counted, max_results);
            } else if ft.is_file() && is_markdown(&name) {
                *counted += 1;
                if *counted > MAX_GREP_FILES {
                    return;
                }
                let lname = name.to_lowercase();
                if lname.contains(needle) {
                    hits.push(GrepHit {
                        path: path.to_string_lossy().to_string(),
                        name: name.clone(),
                        line: 0,
                        preview: String::new(),
                    });
                    if hits.len() >= max_results {
                        return;
                    }
                }
                // 跳过过大文件，避免吃内存
                if let Ok(meta) = entry.metadata() {
                    if meta.len() > MAX_GREP_FILE_SIZE {
                        continue;
                    }
                }
                if let Ok(content) = fs::read_to_string(&path) {
                    let lower = content.to_lowercase();
                    if let Some(idx) = lower.find(needle) {
                        let line_no = content[..idx].matches('\n').count() as u32 + 1;
                        let line_start = content[..idx].rfind('\n').map(|x| x + 1).unwrap_or(0);
                        let line_end = content[idx..]
                            .find('\n')
                            .map(|x| idx + x)
                            .unwrap_or(content.len());
                        let mut preview = content[line_start..line_end].trim().to_string();
                        if preview.chars().count() > 160 {
                            preview = preview.chars().take(160).collect::<String>() + "…";
                        }
                        hits.push(GrepHit {
                            path: path.to_string_lossy().to_string(),
                            name: name.clone(),
                            line: line_no,
                            preview,
                        });
                        if hits.len() >= max_results {
                            return;
                        }
                    }
                }
            }
        }
    }

    visit(
        Path::new(root),
        0,
        &needle,
        &mut hits,
        &mut counted,
        max_results,
    );
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn unlinked_skips_wiki_form() {
        let needle = "笔记";
        assert!(line_has_unlinked("聊聊笔记的设计", needle));
        // 被 [[ 包住就不算
        assert!(!line_has_unlinked("跳转 [[笔记]] 一下", needle));
        // 中文 needle 不强制词边界（无法分词），所以 "笔记本" 中也会命中
        assert!(line_has_unlinked("数据笔记本", needle));
    }

    #[test]
    fn unlinked_ascii_word_boundary() {
        let needle = "roadmap";
        assert!(line_has_unlinked("see roadmap below", needle));
        assert!(!line_has_unlinked("see roadmaps below", needle));
        assert!(!line_has_unlinked("link [[roadmap]] here", needle));
    }

    #[test]
    fn extract_tokens_collects_tags_and_mentions() {
        let mut tags = BTreeSet::new();
        let mut mentions = BTreeSet::new();
        extract_tokens_into(
            "今天 #design 和 @han 一起讨论 #project-x，邮件提到 user@example.com",
            &mut tags,
            &mut mentions,
        );
        assert!(tags.contains("design"));
        assert!(tags.contains("project-x"));
        assert!(mentions.contains("han"));
        // email 中 @ 前是词字符（user），按规则不应被收
        assert!(!mentions.contains("example"));
    }

    #[test]
    fn extract_tokens_dedupes_and_ignores_bare_hash() {
        let mut tags = BTreeSet::new();
        let mut mentions = BTreeSet::new();
        extract_tokens_into("#a #a # not-a-tag", &mut tags, &mut mentions);
        assert_eq!(tags.len(), 1);
        assert!(tags.contains("a"));
    }
}
