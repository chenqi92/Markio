//! 混合检索：向量 top-K + FTS5 关键词 top-K，按 Reciprocal Rank Fusion 融合；
//! 命中的 chunk 再按 link graph 扩展两跳，覆盖关联笔记。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::params;

use super::embed::{self, EmbedConfig};
use super::graph;
use super::rerank::{self, RerankConfig};
use super::{RagHandle, SearchHit};

const RRF_K: f64 = 60.0;

#[derive(Debug, Default, Clone)]
struct Candidate {
    chunk_id: i64,
    score: f64,
    sources: Vec<&'static str>,
}

pub fn search(
    handle: Arc<RagHandle>,
    cfg: EmbedConfig,
    query: &str,
    limit: usize,
    expand_links: bool,
) -> Result<Vec<SearchHit>, String> {
    search_with_rerank(handle, cfg, None, query, limit, expand_links)
}

pub fn search_with_rerank(
    handle: Arc<RagHandle>,
    cfg: EmbedConfig,
    rerank_cfg: Option<RerankConfig>,
    query: &str,
    limit: usize,
    expand_links: bool,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let k = limit.clamp(8, 50);

    // 1. 向量检索
    let vec_hits: Vec<(i64, f32)> = match embed::embed_blocking(&cfg, &[query.to_string()]) {
        Ok(r) => {
            if let Some(v) = r.vectors.first() {
                if r.dim != 0 && r.dim != v.len() {
                    return Err(format!(
                        "Embedding 维度异常：声明 {} 维，实际向量 {} 维",
                        r.dim,
                        v.len()
                    ));
                }
                vector_topk(&handle, v, k * 2)?
            } else {
                vec![]
            }
        }
        Err(e) => {
            eprintln!("[rag.search] embedding 失败，降级为纯 FTS：{e}");
            vec![]
        }
    };

    // 2. FTS 检索
    let fts_hits = fts_topk(&handle, query, k * 2)?;

    // 3. RRF 融合
    let mut merged: HashMap<i64, Candidate> = HashMap::new();
    for (rank, (id, _)) in vec_hits.iter().enumerate() {
        let entry = merged.entry(*id).or_default();
        entry.chunk_id = *id;
        entry.score += 1.0 / (RRF_K + rank as f64 + 1.0);
        if !entry.sources.contains(&"vector") {
            entry.sources.push("vector");
        }
    }
    for (rank, (id, _)) in fts_hits.iter().enumerate() {
        let entry = merged.entry(*id).or_default();
        entry.chunk_id = *id;
        entry.score += 1.0 / (RRF_K + rank as f64 + 1.0);
        if !entry.sources.contains(&"fts") {
            entry.sources.push("fts");
        }
    }
    let mut ranked: Vec<Candidate> = merged.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 4. 图谱扩展：取 top-2 文档的 forward target，补充各 1 个相关 chunk
    if expand_links && !ranked.is_empty() {
        let mut seen: HashSet<i64> = ranked.iter().map(|c| c.chunk_id).collect();
        let top_doc_ids = top_doc_ids_for(&handle, &ranked[..ranked.len().min(3)])?;
        for src_doc_id in top_doc_ids {
            let targets = {
                let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
                let mut ids = graph::forward_targets(&db, src_doc_id);
                if let Some(path) = doc_path_for(&db, src_doc_id) {
                    ids.extend(graph::backlinks(&db, &path));
                }
                ids
            };
            for tgt in targets.into_iter().take(2) {
                if let Some(chunk_id) = first_chunk_of_doc(&handle, tgt)? {
                    if seen.insert(chunk_id) {
                        ranked.push(Candidate {
                            chunk_id,
                            score: 0.001,
                            sources: vec!["graph"],
                        });
                    }
                }
            }
        }
    }

    // 5. 重排（可选）：取 top-(limit*3) 给 reranker，得到精排结果。
    //    注意不能用 clamp(limit, ranked.len())：候选数 < limit 时 min>max 会 panic
    //    （小库 / 稀疏查询 / 仅 FTS 兜底 / 零命中都可能触发），整个搜索失败。
    if let Some(rcfg) = rerank_cfg.as_ref() {
        if !ranked.is_empty() {
        let pool_size = (limit * 3).min(ranked.len());
        let pool: Vec<&Candidate> = ranked.iter().take(pool_size).collect();
        let docs = materialize(&handle, &pool)?;
        let texts: Vec<String> = docs.iter().map(|h| h.body.clone()).collect();
        match rerank::rerank_blocking(rcfg, query, &texts, limit) {
            Ok(order) => {
                let mut reordered: Vec<SearchHit> = Vec::with_capacity(order.len());
                for (idx, score) in order.into_iter().take(limit) {
                    if let Some(mut h) = docs.get(idx).cloned() {
                        h.score = score as f64;
                        h.source = "rerank".to_string();
                        reordered.push(h);
                    }
                }
                if !reordered.is_empty() {
                    return Ok(reordered);
                }
            }
            Err(e) => {
                eprintln!("[rag.rerank] 失败，回退原始排序：{e}");
            }
        }
        }
    }

    // 6. 取前 limit 个，按 chunk_id 拉出展示字段
    let top: Vec<&Candidate> = ranked.iter().take(limit).collect();
    materialize(&handle, &top)
}

fn vector_topk(
    handle: &Arc<RagHandle>,
    query_vec: &[f32],
    k: usize,
) -> Result<Vec<(i64, f32)>, String> {
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let blob: Vec<u8> = query_vec.iter().flat_map(|f| f.to_le_bytes()).collect();
    let mut stmt = db
        .conn
        .prepare(
            "SELECT rowid, distance FROM vec_chunks
             WHERE embedding MATCH ?1 AND k = ?2
             ORDER BY distance",
        )
        .map_err(|e| format!("准备向量查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![blob, k as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)? as f32))
        })
        .map_err(|e| format!("向量查询执行失败：{e}"))?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

fn fts_topk(handle: &Arc<RagHandle>, q: &str, k: usize) -> Result<Vec<(i64, f32)>, String> {
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let safe = sanitize_fts(q);
    if safe.is_empty() {
        return Ok(vec![]);
    }
    let mut stmt = db
        .conn
        .prepare(
            "SELECT rowid, bm25(chunks_fts) FROM chunks_fts WHERE chunks_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|e| format!("准备 FTS 查询失败：{e}"))?;
    let rows = stmt
        .query_map(params![safe, k as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)? as f32))
        })
        .map_err(|e| format!("FTS 查询执行失败：{e}"))?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// 用户输入 → FTS5 安全表达式：去掉 control char，按空白拆词，单字符直接丢，
/// 其它每个词用 `"word"*` 前缀匹配，词间 OR。
fn sanitize_fts(q: &str) -> String {
    let mut terms: Vec<String> = Vec::new();
    for raw in
        q.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '(' | ')' | ',' | ';'))
    {
        let t: String = raw
            .chars()
            .filter(|c| !c.is_control() && *c != '*')
            .collect();
        if t.chars().count() < 1 {
            continue;
        }
        terms.push(format!("\"{t}\"*"));
    }
    terms.join(" OR ")
}

fn top_doc_ids_for(handle: &Arc<RagHandle>, cands: &[Candidate]) -> Result<Vec<i64>, String> {
    if cands.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<String> = cands.iter().map(|c| c.chunk_id.to_string()).collect();
    let in_list = ids.join(",");
    let sql = format!("SELECT DISTINCT doc_id FROM chunks WHERE id IN ({in_list})");
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let mut stmt = db
        .conn
        .prepare(&sql)
        .map_err(|e| format!("准备 doc 查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, i64>(0))
        .map_err(|e| format!("doc 查询失败：{e}"))?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

fn first_chunk_of_doc(handle: &Arc<RagHandle>, doc_id: i64) -> Result<Option<i64>, String> {
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let id: Option<i64> = db
        .conn
        .query_row(
            "SELECT id FROM chunks WHERE doc_id=?1 ORDER BY ord LIMIT 1",
            params![doc_id],
            |r| r.get(0),
        )
        .ok();
    Ok(id)
}

fn doc_path_for(db: &super::db::Db, doc_id: i64) -> Option<String> {
    db.conn
        .query_row("SELECT path FROM docs WHERE id=?1", params![doc_id], |r| {
            r.get::<_, String>(0)
        })
        .ok()
}

fn materialize(handle: &Arc<RagHandle>, cands: &[&Candidate]) -> Result<Vec<SearchHit>, String> {
    if cands.is_empty() {
        return Ok(vec![]);
    }
    let id_index: HashMap<i64, &&Candidate> = cands.iter().map(|c| (c.chunk_id, c)).collect();
    let in_list: String = cands
        .iter()
        .map(|c| c.chunk_id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT c.id, c.heading, c.body, c.char_start, c.char_end, d.path
         FROM chunks c JOIN docs d ON d.id = c.doc_id
         WHERE c.id IN ({in_list})"
    );
    let db = handle.db.lock().map_err(|e| format!("rag lock: {e}"))?;
    let mut stmt = db
        .conn
        .prepare(&sql)
        .map_err(|e| format!("准备结果查询失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
            ))
        })
        .map_err(|e| format!("结果查询失败：{e}"))?;
    let mut hits: Vec<SearchHit> = Vec::new();
    for r in rows.flatten() {
        let cand = id_index.get(&r.0);
        let (score, source) = cand
            .map(|c| (c.score, c.sources.join("+")))
            .unwrap_or((0.0, "".to_string()));
        hits.push(SearchHit {
            path: r.5,
            heading: r.1,
            body: r.2,
            score,
            source,
            char_start: r.3.max(0) as u32,
            char_end: r.4.max(0) as u32,
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(hits)
}
