//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::ignore::IgnoreRules;
use super::walker_io::{is_hidden, is_markdown, ignored_by_rules, MAX_DEPTH};
use super::search::MAX_GREP_FILE_SIZE;
use super::backlinks::is_word_char;

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
        root: &Path,
        dir: &Path,
        depth: usize,
        tags: &mut BTreeSet<String>,
        mentions: &mut BTreeSet<String>,
        files: &mut BTreeSet<String>,
        ignore: &IgnoreRules,
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
            if ignored_by_rules(root, &path, ft.is_dir(), ignore) {
                continue;
            }
            if ft.is_dir() {
                visit(root, &path, depth + 1, tags, mentions, files, ignore);
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

    let root = Path::new(workspace);
    let ignore = IgnoreRules::load(root);
    visit(root, root, 0, &mut tags, &mut mentions, &mut files, &ignore);

    VaultTokens {
        tags: tags.into_iter().collect(),
        mentions: mentions.into_iter().collect(),
        files: files.into_iter().collect(),
    }
}

pub(super) fn extract_tokens_into(
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

