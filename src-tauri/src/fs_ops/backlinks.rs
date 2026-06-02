//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::Path;

use super::search::MAX_GREP_FILE_SIZE;
use super::walker_io::{ignored_by_rules, is_hidden, is_markdown, MAX_DEPTH};
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

/// 在 line 中找 needle 的"未链接"出现：
/// 排除已经被 `[[...]]` 包围的位置。
/// 对 ASCII needle 强制词边界；CJK needle 不强制（中文无分词空格）。
pub(super) fn line_has_unlinked(line_lower: &str, needle: &str) -> bool {
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
