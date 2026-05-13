//! 笔记引用图：提取 `[[wiki]]` 与 markdown 链接（仅指向本地 `.md` 的）。
//!
//! 解析后的关系入库 `links` 表，给 AI 检索时按 from→to 扩展上下文。

use std::path::{Path, PathBuf};

use rusqlite::params;

use super::db::Db;

#[derive(Debug, Clone)]
pub struct Link {
    pub kind: LinkKind,
    pub target_label: String,
    pub target_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    Wiki,
    Md,
}

impl LinkKind {
    fn as_str(self) -> &'static str {
        match self {
            LinkKind::Wiki => "wiki",
            LinkKind::Md => "md",
        }
    }
}

pub fn extract_links(
    source: &str,
    note_path: &Path,
    workspace: &Path,
    md_paths_by_stem: &std::collections::HashMap<String, Vec<PathBuf>>,
) -> Vec<Link> {
    let mut out = Vec::new();
    let mut in_fence = false;
    let mut in_inline_code = false;
    for raw_line in source.lines() {
        let trimmed = raw_line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // wiki link
        let mut idx = 0;
        let bytes = raw_line.as_bytes();
        while idx + 1 < bytes.len() {
            if bytes[idx] == b'[' && bytes[idx + 1] == b'[' {
                if let Some(end) = raw_line[idx + 2..].find("]]") {
                    let raw = &raw_line[idx + 2..idx + 2 + end];
                    let label = raw.split('|').next().unwrap_or(raw).trim();
                    if !label.is_empty() && !label.contains('\n') {
                        let resolved = resolve_wiki(label, workspace, md_paths_by_stem);
                        out.push(Link {
                            kind: LinkKind::Wiki,
                            target_label: label.to_string(),
                            target_path: resolved,
                        });
                    }
                    idx = idx + 2 + end + 2;
                    continue;
                }
            }
            // md link：[text](path.md)
            if !in_inline_code && bytes[idx] == b'[' {
                if let Some(close) = raw_line[idx + 1..].find(']') {
                    let after = idx + 1 + close + 1;
                    if after < bytes.len() && bytes[after] == b'(' {
                        if let Some(rparen) = raw_line[after + 1..].find(')') {
                            let dest = raw_line[after + 1..after + 1 + rparen].trim();
                            if is_local_md(dest) {
                                let abs = resolve_relative(dest, note_path);
                                if let Some(p) = abs {
                                    out.push(Link {
                                        kind: LinkKind::Md,
                                        target_label: raw_line[idx + 1..idx + 1 + close]
                                            .to_string(),
                                        target_path: Some(
                                            p.to_string_lossy().to_string(),
                                        ),
                                    });
                                }
                            }
                            idx = after + 1 + rparen + 1;
                            continue;
                        }
                    }
                }
            }
            // inline code 切换
            if bytes[idx] == b'`' {
                in_inline_code = !in_inline_code;
            }
            idx += 1;
        }
        in_inline_code = false;
    }
    out
}

fn is_local_md(dest: &str) -> bool {
    if dest.is_empty() {
        return false;
    }
    let lower = dest.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with('#')
        || lower.starts_with("data:")
    {
        return false;
    }
    let path_part = dest.split(['?', '#']).next().unwrap_or(dest);
    let lower = path_part.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}

fn resolve_relative(dest: &str, note_path: &Path) -> Option<PathBuf> {
    let path_part = dest.split(['?', '#']).next().unwrap_or(dest);
    let candidate = if Path::new(path_part).is_absolute() {
        PathBuf::from(path_part)
    } else {
        let dir = note_path.parent()?.to_path_buf();
        dir.join(path_part)
    };
    candidate.canonicalize().ok().or(Some(candidate))
}

fn resolve_wiki(
    label: &str,
    _workspace: &Path,
    md_paths_by_stem: &std::collections::HashMap<String, Vec<PathBuf>>,
) -> Option<String> {
    let key = label.to_ascii_lowercase();
    md_paths_by_stem
        .get(&key)
        .and_then(|v| v.first())
        .map(|p| p.to_string_lossy().to_string())
}

/// 删除 doc 的所有出向链接并重新写入。
pub fn replace_links(db: &Db, doc_id: i64, links: &[Link]) -> Result<(), String> {
    db.conn
        .execute("DELETE FROM links WHERE from_doc=?1", params![doc_id])
        .map_err(|e| format!("清空旧 links 失败：{e}"))?;
    let mut stmt = db
        .conn
        .prepare(
            "INSERT INTO links(from_doc, to_path, target_label, kind) VALUES(?1, ?2, ?3, ?4)",
        )
        .map_err(|e| format!("准备 links 写入失败：{e}"))?;
    for l in links {
        let to_path = l.target_path.clone().unwrap_or_default();
        stmt.execute(params![
            doc_id,
            to_path,
            l.target_label,
            l.kind.as_str()
        ])
        .map_err(|e| format!("写 links 失败：{e}"))?;
    }
    Ok(())
}

/// 查 doc 的 forward links 指向的其他 doc_id（仅返回能解析到本仓库 .md 的）
pub fn forward_targets(db: &Db, doc_id: i64) -> Vec<i64> {
    let mut out = Vec::new();
    let Ok(mut stmt) = db.conn.prepare(
        "SELECT d.id FROM links l JOIN docs d ON d.path = l.to_path WHERE l.from_doc = ?1",
    ) else {
        return out;
    };
    if let Ok(rows) = stmt.query_map(params![doc_id], |r| r.get::<_, i64>(0)) {
        for r in rows.flatten() {
            out.push(r);
        }
    }
    out
}

/// backlinks：哪些 doc 指向了 path
pub fn backlinks(db: &Db, path: &str) -> Vec<i64> {
    let mut out = Vec::new();
    let Ok(mut stmt) =
        db.conn
            .prepare("SELECT DISTINCT from_doc FROM links WHERE to_path = ?1")
    else {
        return out;
    };
    if let Ok(rows) = stmt.query_map(params![path], |r| r.get::<_, i64>(0)) {
        for r in rows.flatten() {
            out.push(r);
        }
    }
    out
}
