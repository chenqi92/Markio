//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::Path;

use super::search::MAX_GREP_FILE_SIZE;
use super::snapshots::save_snapshot;
use super::walker_io::{atomic_write, ignored_by_rules, is_hidden, is_markdown, MAX_DEPTH};
use crate::ignore::IgnoreRules;

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

    let root = Path::new(workspace);
    let ignore = IgnoreRules::load(root);
    struct BacklinkVisit<'a> {
        root: &'a Path,
        needle: &'a str,
        skip: &'a str,
        max: usize,
        ignore: &'a IgnoreRules,
    }
    impl BacklinkVisit<'_> {
        fn visit(&self, dir: &Path, depth: usize, out: &mut Vec<Backlink>) {
            if out.len() >= self.max || depth > MAX_DEPTH {
                return;
            }
            let entries = match fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                if out.len() >= self.max {
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
                if ignored_by_rules(self.root, &path, ft.is_dir(), self.ignore) {
                    continue;
                }
                if ft.is_dir() {
                    self.visit(&path, depth + 1, out);
                } else if ft.is_file() && is_markdown(&name) {
                    // 跳过自身
                    if path.to_string_lossy() == self.skip {
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
                    let key = format!("[[{}", self.needle);
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
    }
    BacklinkVisit {
        root,
        needle: &needle,
        skip: file,
        max,
        ignore: &ignore,
    }
    .visit(root, 0, &mut out);
    out
}

/// 是否是 Unicode 词字符（字母 / 数字 / 下划线 / CJK）。
pub(super) fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// 在 line 中找 needle 第一个"未链接"出现的起始字节偏移：
/// 排除已经被 `[[...]]` 包围的位置。
/// 对 ASCII needle 强制词边界；CJK needle 不强制（中文无分词空格）。
pub(super) fn first_unlinked_offset(line_lower: &str, needle: &str) -> Option<usize> {
    let ascii_needle = needle.is_ascii();
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
            return Some(abs);
        }
        start = abs + nlen.max(1);
        if start >= line_lower.len() {
            break;
        }
    }
    None
}

pub(super) fn line_has_unlinked(line_lower: &str, needle: &str) -> bool {
    first_unlinked_offset(line_lower, needle).is_some()
}

/// 把 file 第 `line` 行（1-based）里第一个"未链接"的 needle 出现包成 `[[needle]]`。
/// 先存历史快照再原子写；返回是否真的改写了（行号越界 / 无未链接出现 → false）。
/// needle 是被链接到的笔记标题（按 stem 匹配，大小写不敏感）。
pub fn link_mention_in_file(
    workspace: &str,
    file: &str,
    line: u32,
    needle: &str,
) -> Result<bool, String> {
    let needle_lower = needle.to_lowercase();
    if needle_lower.is_empty() || line == 0 {
        return Ok(false);
    }
    let content = fs::read_to_string(file).map_err(|e| e.to_string())?;
    let bytes = content.as_bytes();

    // 定位第 line 行起点
    let mut idx = 0usize;
    let mut ln = 1u32;
    while idx < bytes.len() && ln < line {
        if bytes[idx] == b'\n' {
            ln += 1;
        }
        idx += 1;
    }
    if ln < line {
        return Ok(false);
    }
    let line_start = idx;
    let mut line_end = line_start;
    while line_end < bytes.len() && bytes[line_end] != b'\n' {
        line_end += 1;
    }
    let line_str = &content[line_start..line_end];

    let line_lower = line_str.to_lowercase();
    // 仅在 lowercasing 保持字节长度时映射偏移（ASCII / CJK 都满足）；否则放弃，避免错位
    if line_lower.len() != line_str.len() {
        return Ok(false);
    }
    let Some(rel_start) = first_unlinked_offset(&line_lower, &needle_lower) else {
        return Ok(false);
    };
    let abs_start = line_start + rel_start;
    let abs_end = abs_start + needle_lower.len();
    if abs_end > content.len()
        || !content.is_char_boundary(abs_start)
        || !content.is_char_boundary(abs_end)
    {
        return Ok(false);
    }
    let new_content = format!(
        "{}[[{}]]{}",
        &content[..abs_start],
        &content[abs_start..abs_end],
        &content[abs_end..]
    );

    let _ = save_snapshot(workspace, file, &content);
    atomic_write(Path::new(file), &new_content)?;
    Ok(true)
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

    let root = Path::new(workspace);
    let ignore = IgnoreRules::load(root);
    struct MentionVisit<'a> {
        root: &'a Path,
        needle: &'a str,
        skip: &'a str,
        max: usize,
        ignore: &'a IgnoreRules,
    }
    impl MentionVisit<'_> {
        fn visit(&self, dir: &Path, depth: usize, out: &mut Vec<Backlink>) {
            if out.len() >= self.max || depth > MAX_DEPTH {
                return;
            }
            let entries = match fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                if out.len() >= self.max {
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
                if ignored_by_rules(self.root, &path, ft.is_dir(), self.ignore) {
                    continue;
                }
                if ft.is_dir() {
                    self.visit(&path, depth + 1, out);
                } else if ft.is_file() && is_markdown(&name) {
                    if path.to_string_lossy() == self.skip {
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
                    if !lower.contains(self.needle) {
                        continue;
                    }
                    for (i, line) in content.lines().enumerate() {
                        let lline = line.to_lowercase();
                        if !line_has_unlinked(&lline, self.needle) {
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
    }
    MentionVisit {
        root,
        needle: &needle,
        skip: file,
        max,
        ignore: &ignore,
    }
    .visit(root, 0, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_ws(name: &str) -> PathBuf {
        let unique = format!(
            "markio-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let ws = std::env::temp_dir().join(unique);
        fs::create_dir_all(&ws).unwrap();
        ws
    }

    #[test]
    fn first_unlinked_offset_basics() {
        assert_eq!(first_unlinked_offset("see roadmap here", "roadmap"), Some(4));
        // 词内不算（roadmaps 不是 roadmap 的边界出现）
        assert_eq!(first_unlinked_offset("see roadmaps", "roadmap"), None);
        // 已链接的不算
        assert_eq!(first_unlinked_offset("link [[roadmap]]", "roadmap"), None);
    }

    #[test]
    fn link_mention_wraps_first_occurrence() {
        let ws = temp_ws("linkmention");
        let file = ws.join("note.md");
        fs::write(&file, "前言\n这里提到 Roadmap 很重要\n结尾\n").unwrap();
        let changed = link_mention_in_file(
            &ws.to_string_lossy(),
            &file.to_string_lossy(),
            2,
            "roadmap",
        )
        .unwrap();
        assert!(changed);
        let out = fs::read_to_string(&file).unwrap();
        assert_eq!(out, "前言\n这里提到 [[Roadmap]] 很重要\n结尾\n");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn link_mention_skips_already_linked() {
        let ws = temp_ws("linkmention2");
        let file = ws.join("n.md");
        fs::write(&file, "已链接 [[Roadmap]] 在此\n").unwrap();
        let changed =
            link_mention_in_file(&ws.to_string_lossy(), &file.to_string_lossy(), 1, "roadmap")
                .unwrap();
        assert!(!changed);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn link_mention_out_of_range_line() {
        let ws = temp_ws("linkmention3");
        let file = ws.join("n.md");
        fs::write(&file, "只有一行 Roadmap\n").unwrap();
        let changed =
            link_mention_in_file(&ws.to_string_lossy(), &file.to_string_lossy(), 9, "roadmap")
                .unwrap();
        assert!(!changed);
        let _ = fs::remove_dir_all(&ws);
    }
}
