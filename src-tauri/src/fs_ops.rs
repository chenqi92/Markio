use serde::Serialize;
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
}

const MAX_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 8_000;
const MAX_DIR_CHILDREN: usize = 2_000;

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
                });
            }
        };

        let mut dirs: Vec<(PathBuf, String)> = Vec::new();
        let mut files: Vec<FileEntry> = Vec::new();

        let mut local_count = 0usize;
        for entry in entries.flatten() {
            if local_count >= MAX_DIR_CHILDREN {
                break;
            }
            local_count += 1;
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
        return Err(format!("路径不存在：{}", root_path));
    }
    if !root.is_dir() {
        return Err(format!("不是文件夹：{}", root_path));
    }
    let mut w = Walker {
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

fn snapshot_key(file: &Path, workspace: &Path) -> String {
    // 用相对路径做 key，把 / 替换为 ¦，避免目录嵌套
    let rel = file.strip_prefix(workspace).unwrap_or(file);
    rel.to_string_lossy().replace(['/', '\\'], "¦")
}

pub fn save_snapshot(workspace: &str, file: &str, content: &str) -> Result<(), String> {
    let ws_path = PathBuf::from(workspace);
    let file_path = PathBuf::from(file);
    let dir = snapshot_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key = snapshot_key(&file_path, &ws_path);
    let ts = chrono::Utc::now().timestamp_millis();
    let snap_name = format!("{}__{}.md", key, ts);
    let snap_path = dir.join(snap_name);
    fs::write(&snap_path, content).map_err(|e| e.to_string())?;
    // 同一文件最多保留 30 份
    prune_snapshots(&dir, &key, 30)?;
    Ok(())
}

fn prune_snapshots(dir: &Path, key: &str, max: usize) -> Result<(), String> {
    let prefix = format!("{}__", key);
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
    let key = snapshot_key(&file_path, &ws_path);
    let prefix = format!("{}__", key);
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
                let key = format!("[[{}", needle);
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
        return Err(format!("文件不存在：{}", file));
    }
    let dir = trash_dir(workspace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无效文件名".to_string())?;
    let ts = ts_now();
    let stored = format!("{}__{}.bin", ts, name);
    let meta_path = dir.join(format!("{}__{}.meta.json", ts, name));
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
        let stored = dir.join(format!("{}__{}.bin", ts, orig_name));
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
    let stored_path = PathBuf::from(stored);
    if !stored_path.exists() {
        return Err("回收站项目不存在".to_string());
    }
    // 找 meta
    let dir = trash_dir(workspace);
    let stem = stored_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let meta_path = dir.join(format!("{}.meta.json", stem));
    let s = fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let original = v
        .get("original")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "丢失原始路径".to_string())?
        .to_string();
    let dest = PathBuf::from(&original);
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
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
    if let Some(path) = stored {
        let p = PathBuf::from(&path);
        if p.exists() {
            let _ = fs::remove_file(&p);
        }
        // meta 也一起删
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = dir.join(format!("{}.meta.json", stem));
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
        return Err(format!("路径不存在：{}", path));
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
        return Ok(());
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
