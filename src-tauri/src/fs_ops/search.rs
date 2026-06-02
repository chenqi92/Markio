//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::Serialize;
use std::fs;
use std::path::Path;

use super::walker_io::{
    attachment_kind, ignored_by_rules, is_hidden, is_markdown, modified_ms, MAX_DEPTH, MAX_ENTRIES,
};
use crate::ignore::IgnoreRules;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrepHit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub preview: String,
}

pub(super) const MAX_GREP_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MB
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

    fn visit(
        root: &Path,
        dir: &Path,
        depth: usize,
        out: &mut Vec<Attachment>,
        max: usize,
        ignore: &IgnoreRules,
    ) {
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
            if ignored_by_rules(root, &path, ft.is_dir(), ignore) {
                continue;
            }
            if ft.is_dir() {
                visit(root, &path, depth + 1, out, max, ignore);
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

    let root_path = Path::new(root);
    let ignore = IgnoreRules::load(root_path);
    visit(root_path, root_path, 0, &mut out, max, &ignore);
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

    let root_path = Path::new(root);
    let ignore = IgnoreRules::load(root_path);
    struct GrepVisit<'a> {
        root: &'a Path,
        needle: &'a str,
        max_results: usize,
        ignore: &'a IgnoreRules,
    }
    impl GrepVisit<'_> {
        fn visit(&self, dir: &Path, depth: usize, hits: &mut Vec<GrepHit>, counted: &mut usize) {
            if hits.len() >= self.max_results || depth > MAX_DEPTH || *counted > MAX_ENTRIES {
                return;
            }
            let entries = match fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };
            for entry in entries.flatten() {
                if hits.len() >= self.max_results {
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
                    self.visit(&path, depth + 1, hits, counted);
                } else if ft.is_file() && is_markdown(&name) {
                    *counted += 1;
                    if *counted > MAX_GREP_FILES {
                        return;
                    }
                    let lname = name.to_lowercase();
                    if lname.contains(self.needle) {
                        hits.push(GrepHit {
                            path: path.to_string_lossy().to_string(),
                            name: name.clone(),
                            line: 0,
                            preview: String::new(),
                        });
                        if hits.len() >= self.max_results {
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
                        if let Some(idx) = lower.find(self.needle) {
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
                            if hits.len() >= self.max_results {
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
    GrepVisit {
        root: root_path,
        needle: &needle,
        max_results,
        ignore: &ignore,
    }
    .visit(root_path, 0, &mut hits, &mut counted);
    hits
}

#[cfg(test)]
mod tests {
    use super::super::backlinks::line_has_unlinked;
    use super::super::tokens::extract_tokens_into;
    use super::super::trash::{
        trash_dir, trash_item_paths, trash_list, trash_move, trash_purge, trash_restore,
    };
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn make_test_workspace(name: &str) -> PathBuf {
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

    #[test]
    fn trash_roundtrip_directory() {
        let ws = make_test_workspace("trash-dir");
        let dir = ws.join("Project");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("note.md"), "# Note").unwrap();

        trash_move(&ws.to_string_lossy(), &dir.to_string_lossy()).unwrap();
        assert!(!dir.exists());

        let items = trash_list(&ws.to_string_lossy()).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].is_dir);
        assert!(Path::new(&items[0].path).is_dir());

        let restored = trash_restore(&ws.to_string_lossy(), &items[0].path).unwrap();
        assert_eq!(restored, dir.to_string_lossy());
        assert!(dir.join("note.md").exists());
        assert!(trash_list(&ws.to_string_lossy()).unwrap().is_empty());

        let _ = fs::remove_dir_all(ws);
    }

    #[test]
    fn trash_purge_directory() {
        let ws = make_test_workspace("trash-purge-dir");
        let dir = ws.join("Project");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("note.md"), "# Note").unwrap();

        trash_move(&ws.to_string_lossy(), &dir.to_string_lossy()).unwrap();
        let item = trash_list(&ws.to_string_lossy()).unwrap().remove(0);
        trash_purge(&ws.to_string_lossy(), Some(item.path.clone())).unwrap();
        assert!(!Path::new(&item.path).exists());

        let _ = fs::remove_dir_all(ws);
    }

    #[test]
    fn trash_item_paths_do_not_reuse_existing_names() {
        let ws = make_test_workspace("trash-collision");
        let trash = trash_dir(&ws.to_string_lossy());
        fs::create_dir_all(&trash).unwrap();

        let (stored_a, stored_path_a, meta_path_a) =
            trash_item_paths(&trash, 123, "Project", true).unwrap();
        fs::create_dir_all(&stored_path_a).unwrap();
        fs::write(&meta_path_a, "{}").unwrap();

        let (stored_b, stored_path_b, meta_path_b) =
            trash_item_paths(&trash, 123, "Project", true).unwrap();

        assert_ne!(stored_a, stored_b);
        assert!(!stored_path_b.exists());
        assert!(!meta_path_b.exists());
        assert!(stored_b.contains("__1__Project.dir"));

        let _ = fs::remove_dir_all(ws);
    }
}
