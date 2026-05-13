//! 索引调度：扫描仓库 → 比对 hash → 分块 → embedding → 写库 + 链接图。
//!
//! 核心入口：
//! - [`reindex_workspace`]：全量重建（先扫描后差分，删除不存在的 docs）
//! - [`reindex_file`]：单文件刷新（保存后触发）
//! - [`remove_file`]：从索引里删除（文件被删 / 移动）

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::params;

use super::chunk;
use super::db::Db;
use super::embed::{self, EmbedConfig};
use super::graph;
use super::{IndexProgress, RagHandle};

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    ".markio",
    ".obsidian",
    ".vscode",
    ".idea",
    "__pycache__",
];

/// FNV-1a 64-bit；和保存路径上用的 hash 同一族。
fn content_hash(data: &[u8]) -> String {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;
    let mut h = OFFSET;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(PRIME);
    }
    format!("{:016x}", h)
}

#[derive(Debug, Clone)]
struct Doc {
    path: PathBuf,
    mtime: i64,
    size: u64,
    hash: String,
    content: String,
}

fn collect_md(workspace: &Path, max_files: usize) -> Vec<Doc> {
    let mut out = Vec::new();
    walk(workspace, 0, &mut out, max_files);
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<Doc>, max_files: usize) {
    if depth > 12 || out.len() >= max_files {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= max_files {
            return;
        }
        let path = e.path();
        let name_lower = path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if SKIP_DIRS.iter().any(|s| name_lower == *s) {
                continue;
            }
            walk(&path, depth + 1, out, max_files);
        } else if ft.is_file() {
            if !is_md(&name_lower) {
                continue;
            }
            let Ok(md) = path.metadata() else { continue };
            let size = md.len();
            if size > 4_000_000 {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let hash = content_hash(content.as_bytes());
            out.push(Doc {
                path,
                mtime,
                size,
                hash,
                content,
            });
        }
    }
}

fn is_md(name_lower: &str) -> bool {
    name_lower.ends_with(".md")
        || name_lower.ends_with(".markdown")
        || name_lower.ends_with(".mdown")
        || name_lower.ends_with(".mkd")
}

fn build_stem_index(docs: &[Doc]) -> HashMap<String, Vec<PathBuf>> {
    let mut map: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for d in docs {
        let stem = d
            .path
            .file_stem()
            .and_then(OsStr::to_str)
            .map(|s| s.to_ascii_lowercase());
        if let Some(s) = stem {
            map.entry(s).or_default().push(d.path.clone());
        }
    }
    map
}

/// 全量重建索引。
pub fn reindex_workspace(handle: Arc<RagHandle>, cfg: EmbedConfig) -> Result<(), String> {
    let workspace = PathBuf::from(&handle.workspace);
    let docs = collect_md(&workspace, 20_000);
    let total = docs.len() as u32;

    {
        let mut db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
        db.progress = Some(IndexProgress {
            running: true,
            processed: 0,
            total,
            current_file: None,
            last_error: None,
        });
    }

    let stem_index = build_stem_index(&docs);

    // 先收集仓库里现存路径，便于结束后删除已不存在的 docs
    let live_paths: std::collections::HashSet<String> = docs
        .iter()
        .map(|d| d.path.to_string_lossy().to_string())
        .collect();

    let mut last_err: Option<String> = None;
    for (i, doc) in docs.iter().enumerate() {
        {
            let mut db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
            if let Some(p) = db.progress.as_mut() {
                p.processed = i as u32;
                p.current_file = Some(doc.path.to_string_lossy().to_string());
            }
        }
        if let Err(e) = upsert_doc(&handle, &cfg, doc, &workspace, &stem_index) {
            last_err = Some(format!(
                "{}: {e}",
                doc.path.to_string_lossy()
            ));
            // 单文件失败不阻止整体推进
            let mut db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
            if let Some(p) = db.progress.as_mut() {
                p.last_error = last_err.clone();
            }
        }
    }

    // 清理已不存在的 docs
    {
        let mut db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
        prune_missing(&mut db, &live_paths)?;
        db.set_meta(
            "embedding_provider",
            cfg.provider.as_str(),
        )?;
        db.set_meta("embedding_model", &cfg.model)?;
        db.set_meta(
            "last_full_scan",
            &chrono::Utc::now().timestamp().to_string(),
        )?;
        if let Some(p) = db.progress.as_mut() {
            p.running = false;
            p.processed = total;
            p.current_file = None;
        }
    }
    if let Some(e) = last_err {
        if total == 1 {
            return Err(e);
        }
    }
    Ok(())
}

/// 把单个文件刷新进索引；返回是否触达 embedding（用于上游决定提示）。
pub fn reindex_file(
    handle: Arc<RagHandle>,
    cfg: EmbedConfig,
    path: &Path,
) -> Result<bool, String> {
    let md = path
        .metadata()
        .map_err(|e| format!("读取文件元数据失败：{e}"))?;
    if !md.is_file() {
        return Ok(false);
    }
    let size = md.len();
    let content = fs::read_to_string(path).map_err(|e| format!("读取文件失败：{e}"))?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let hash = content_hash(content.as_bytes());
    let doc = Doc {
        path: path.to_path_buf(),
        mtime,
        size,
        hash,
        content,
    };
    let workspace = PathBuf::from(&handle.workspace);
    // 单文件不重建 stem 索引；wiki 解析允许 target_path 为空（仅记 label）
    let stem_index: HashMap<String, Vec<PathBuf>> = HashMap::new();
    upsert_doc(&handle, &cfg, &doc, &workspace, &stem_index)?;
    Ok(true)
}

fn upsert_doc(
    handle: &Arc<RagHandle>,
    cfg: &EmbedConfig,
    doc: &Doc,
    workspace: &Path,
    stem_index: &HashMap<String, Vec<PathBuf>>,
) -> Result<(), String> {
    let path_str = doc.path.to_string_lossy().to_string();
    // 1. 查现有 doc，hash 一致则跳过
    let existing = {
        let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
        db.conn
            .query_row(
                "SELECT id, hash FROM docs WHERE path=?1",
                params![path_str],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .ok()
    };
    if let Some((doc_id, prev_hash)) = existing.clone() {
        if prev_hash == doc.hash {
            // hash 未变也确认向量是否齐全
            let chunk_count = {
                let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
                db.conn
                    .query_row(
                        "SELECT COUNT(*) FROM chunks WHERE doc_id=?1",
                        params![doc_id],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
            };
            let vec_count = {
                let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
                db.conn
                    .query_row(
                        "SELECT COUNT(*) FROM vec_chunks v JOIN chunks c ON c.id = v.rowid WHERE c.doc_id=?1",
                        params![doc_id],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
            };
            if chunk_count > 0 && chunk_count == vec_count {
                return Ok(());
            }
        }
    }

    // 2. 分块
    let chunks = chunk::split(&doc.content);
    if chunks.is_empty() {
        return Ok(());
    }
    let bodies: Vec<String> = chunks
        .iter()
        .map(|c| {
            if c.heading.is_empty() {
                c.body.clone()
            } else {
                format!("{}\n\n{}", c.heading, c.body)
            }
        })
        .collect();

    // 3. embedding（这一步耗时最长；不持锁）
    let embed_res = embed::embed_blocking(cfg, &bodies)?;
    if embed_res.vectors.len() != chunks.len() {
        return Err(format!(
            "Embedding 数量异常：期望 {}，实际 {}",
            chunks.len(),
            embed_res.vectors.len()
        ));
    }

    // 4. 写库：删除旧 chunks（FK 会带掉 vec 行不？vec0 不在级联范围；显式删）
    let doc_id = {
        let mut db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
        let tx = db
            .conn
            .transaction()
            .map_err(|e| format!("开启事务失败：{e}"))?;
        let id = if let Some((id, _)) = existing {
            // 显式清掉旧 vec 行
            tx.execute(
                "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?1)",
                params![id],
            )
            .map_err(|e| format!("清旧 vec 失败：{e}"))?;
            tx.execute("DELETE FROM chunks WHERE doc_id=?1", params![id])
                .map_err(|e| format!("清旧 chunks 失败：{e}"))?;
            tx.execute(
                "UPDATE docs SET mtime=?1, size=?2, hash=?3, indexed_at=?4, status='ok' WHERE id=?5",
                params![
                    doc.mtime,
                    doc.size as i64,
                    doc.hash,
                    chrono::Utc::now().timestamp(),
                    id
                ],
            )
            .map_err(|e| format!("更新 doc 失败：{e}"))?;
            id
        } else {
            tx.execute(
                "INSERT INTO docs(path, mtime, size, hash, indexed_at, status) VALUES(?1, ?2, ?3, ?4, ?5, 'ok')",
                params![
                    path_str,
                    doc.mtime,
                    doc.size as i64,
                    doc.hash,
                    chrono::Utc::now().timestamp()
                ],
            )
            .map_err(|e| format!("插入 doc 失败：{e}"))?;
            tx.last_insert_rowid()
        };

        for (ord, (c, vec)) in chunks
            .iter()
            .zip(embed_res.vectors.iter())
            .enumerate()
        {
            tx.execute(
                "INSERT INTO chunks(doc_id, ord, heading, char_start, char_end, body, token_count)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    ord as i64,
                    c.heading,
                    c.char_start as i64,
                    c.char_end as i64,
                    c.body,
                    c.token_count as i64,
                ],
            )
            .map_err(|e| format!("插入 chunk 失败：{e}"))?;
            let chunk_id = tx.last_insert_rowid();
            let blob = vec_to_blob(vec);
            tx.execute(
                "INSERT INTO vec_chunks(rowid, embedding) VALUES(?1, ?2)",
                params![chunk_id, blob],
            )
            .map_err(|e| format!("插入向量失败：{e}"))?;
        }
        tx.commit().map_err(|e| format!("提交索引事务失败：{e}"))?;
        id
    };

    // 5. 链接图
    let links = graph::extract_links(&doc.content, &doc.path, workspace, stem_index);
    let _ = links_for_doc(handle, doc_id, &links);

    Ok(())
}

fn links_for_doc(
    handle: &Arc<RagHandle>,
    doc_id: i64,
    links: &[graph::Link],
) -> Result<(), String> {
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    graph::replace_links(&db, doc_id, links)
}

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

pub fn prune_missing(db: &mut Db, live: &std::collections::HashSet<String>) -> Result<(), String> {
    let mut to_remove: Vec<i64> = Vec::new();
    {
        let mut stmt = db
            .conn
            .prepare("SELECT id, path FROM docs")
            .map_err(|e| format!("查 docs 失败：{e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("遍历 docs 失败：{e}"))?;
        for r in rows.flatten() {
            if !live.contains(&r.1) {
                to_remove.push(r.0);
            }
        }
    }
    if to_remove.is_empty() {
        return Ok(());
    }
    let tx = db
        .conn
        .transaction()
        .map_err(|e| format!("开启事务失败：{e}"))?;
    for id in to_remove {
        tx.execute(
            "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?1)",
            params![id],
        )
        .map_err(|e| format!("清向量失败：{e}"))?;
        tx.execute("DELETE FROM docs WHERE id=?1", params![id])
            .map_err(|e| format!("删 doc 失败：{e}"))?;
    }
    tx.commit().map_err(|e| format!("提交清理事务失败：{e}"))?;
    Ok(())
}

pub fn remove_file(handle: Arc<RagHandle>, path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy().to_string();
    let mut db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let id: Option<i64> = db
        .conn
        .query_row(
            "SELECT id FROM docs WHERE path=?1",
            params![path_str],
            |r| r.get(0),
        )
        .ok();
    let Some(id) = id else { return Ok(()) };
    let tx = db
        .conn
        .transaction()
        .map_err(|e| format!("开启事务失败：{e}"))?;
    tx.execute(
        "DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id=?1)",
        params![id],
    )
    .map_err(|e| format!("清向量失败：{e}"))?;
    tx.execute("DELETE FROM docs WHERE id=?1", params![id])
        .map_err(|e| format!("删 doc 失败：{e}"))?;
    tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
    Ok(())
}
