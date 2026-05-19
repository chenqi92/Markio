//! RAG 向量索引 + 关键词 + 图谱混合检索。
//!
//! 数据存储：每个 workspace 下 `.markio/rag.db`。
//! - `docs` / `chunks` 主存
//! - `vec_chunks`（sqlite-vec vec0）向量索引
//! - `chunks_fts`（FTS5）关键词索引
//! - `links` 跨笔记引用图
//!
//! 设计要点：
//! - 索引/检索通过 [`rag_handle`] 拿到 per-workspace 单例（包含连接池 + 互斥）；
//! - Embedding 接 [`embed::EmbedClient`]，支持 Ollama / OpenAI 兼容；
//! - 检索走混合：向量 top-K + FTS top-K，按 RRF 融合，再用 link graph 扩展。

pub mod chunk;
pub mod db;
pub mod embed;
pub mod graph;
pub mod index;
pub mod rerank;
pub mod search;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use db::Db;

/// 索引一次/检索一次共享的句柄。
pub struct RagHandle {
    pub db: Arc<Mutex<Db>>,
    /// workspace 绝对路径
    pub workspace: String,
}

static HANDLES: OnceLock<Mutex<HashMap<String, Arc<RagHandle>>>> = OnceLock::new();

fn handles() -> &'static Mutex<HashMap<String, Arc<RagHandle>>> {
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 拿到 workspace 对应的 [`RagHandle`]（首次会建库 + 跑迁移）。
pub fn rag_handle(workspace: &str, embed_dim: usize) -> Result<Arc<RagHandle>, String> {
    let key = workspace.to_string();
    {
        let map = handles().lock().map_err(|e| format!("rag lock: {e}"))?;
        if let Some(h) = map.get(&key) {
            return Ok(h.clone());
        }
    }
    let db = Db::open(Path::new(workspace), embed_dim)?;
    let handle = Arc::new(RagHandle {
        db: Arc::new(Mutex::new(db)),
        workspace: key.clone(),
    });
    let mut map = handles().lock().map_err(|e| format!("rag lock: {e}"))?;
    map.insert(key, handle.clone());
    Ok(handle)
}

/// Returns the in-memory handle if the workspace has already been opened.
pub fn existing_handle(workspace: &str) -> Option<Arc<RagHandle>> {
    handles().lock().ok()?.get(workspace).cloned()
}

/// 当切换 embedding 模型 / 维度变化时调用：清理内存里的句柄，下一次会重新打开 DB。
pub fn drop_handle(workspace: &str) {
    if let Ok(mut map) = handles().lock() {
        map.remove(workspace);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub workspace: String,
    pub total_docs: u32,
    pub total_chunks: u32,
    pub indexed_at: Option<i64>,
    pub embedding_model: Option<String>,
    pub embedding_provider: Option<String>,
    pub embedding_dim: Option<u32>,
    pub db_size: u64,
    pub progress: Option<IndexProgress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub running: bool,
    pub cancel_requested: bool,
    pub processed: u32,
    pub total: u32,
    pub current_file: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub heading: String,
    pub body: String,
    pub score: f64,
    pub source: String,
    pub char_start: u32,
    pub char_end: u32,
}
