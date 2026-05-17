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
                                        target_path: Some(p.to_string_lossy().to_string()),
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
        .prepare("INSERT INTO links(from_doc, to_path, target_label, kind) VALUES(?1, ?2, ?3, ?4)")
        .map_err(|e| format!("准备 links 写入失败：{e}"))?;
    for l in links {
        let to_path = l.target_path.clone().unwrap_or_default();
        stmt.execute(params![doc_id, to_path, l.target_label, l.kind.as_str()])
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

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: i64,
    pub path: String,
    /// 入度（被多少 doc 指向）
    pub in_degree: u32,
    /// 出度
    pub out_degree: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// 整个仓库的链接图。节点 = docs；边 = links（双向链接合并成两条单向边）。
pub fn repo_graph(db: &Db) -> Result<RepoGraph, String> {
    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut id_to_idx: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    let mut stmt = db
        .conn
        .prepare("SELECT id, path FROM docs")
        .map_err(|e| format!("准备查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| format!("查询失败：{e}"))?;
    for row in rows.flatten() {
        let (id, path) = row;
        id_to_idx.insert(id, nodes.len());
        nodes.push(GraphNode {
            id,
            path,
            in_degree: 0,
            out_degree: 0,
        });
    }

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut estmt = db
        .conn
        .prepare(
            "SELECT l.from_doc, d.id FROM links l \
             JOIN docs d ON d.path = l.to_path",
        )
        .map_err(|e| format!("准备查询失败：{e}"))?;
    let rows = estmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| format!("查询失败：{e}"))?;
    for row in rows.flatten() {
        let (from, to) = row;
        if let Some(i) = id_to_idx.get(&from) {
            nodes[*i].out_degree += 1;
        }
        if let Some(i) = id_to_idx.get(&to) {
            nodes[*i].in_degree += 1;
        }
        edges.push(GraphEdge { from, to });
    }

    Ok(RepoGraph { nodes, edges })
}

/// backlinks：哪些 doc 指向了 path
pub fn backlinks(db: &Db, path: &str) -> Vec<i64> {
    let mut out = Vec::new();
    let Ok(mut stmt) = db
        .conn
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn empty_stems() -> HashMap<String, Vec<PathBuf>> {
        HashMap::new()
    }

    #[test]
    fn extract_wiki_link_with_label() {
        let src = "see [[Alpha]] and [[Beta|友好别名]]";
        let links = extract_links(src, Path::new("/ws/a.md"), Path::new("/ws"), &empty_stems());
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].kind, LinkKind::Wiki);
        assert_eq!(links[0].target_label, "Alpha");
        assert_eq!(links[1].target_label, "Beta");
    }

    #[test]
    fn wiki_resolves_via_stem_map() {
        let mut stems = HashMap::new();
        stems.insert("alpha".to_string(), vec![PathBuf::from("/ws/Alpha.md")]);
        let src = "see [[Alpha]]";
        let links = extract_links(src, Path::new("/ws/a.md"), Path::new("/ws"), &stems);
        assert_eq!(links[0].target_path.as_deref(), Some("/ws/Alpha.md"));
    }

    #[test]
    fn extract_md_link_local_only() {
        let src = "[doc](./other.md) and [web](https://x.com) and [anchor](#sec)";
        let links = extract_links(src, Path::new("/ws/a.md"), Path::new("/ws"), &empty_stems());
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].kind, LinkKind::Md);
        assert_eq!(links[0].target_label, "doc");
    }

    #[test]
    fn fenced_code_block_is_skipped() {
        let src = "```\n[[InCodeFence]]\n[real](./x.md)\n```\nafter [[Outside]]";
        let links = extract_links(src, Path::new("/ws/a.md"), Path::new("/ws"), &empty_stems());
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_label, "Outside");
    }

    #[test]
    fn is_local_md_recognizes_extensions() {
        assert!(is_local_md("foo.md"));
        assert!(is_local_md("foo.markdown"));
        assert!(is_local_md("a/b/c.mdown?x=1"));
        assert!(!is_local_md("https://x.md"));
        assert!(!is_local_md("#sec"));
        assert!(!is_local_md(""));
    }
}
