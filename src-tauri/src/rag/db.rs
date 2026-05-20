//! sqlite + sqlite-vec + FTS5 数据库层。
//!
//! - 首次打开时通过 [`load_vec_extension`] 注册 vec0 模块
//! - 通过 schema_meta 表跟踪 schema_version 与 embedding_dim；维度变更需要 [`rebuild_vector_table`]

use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Once;

use rusqlite::{params, Connection};

use super::IndexProgress;

const SCHEMA_VERSION: i64 = 1;

pub struct Db {
    pub conn: Connection,
    pub embed_dim: usize,
    pub progress: Option<IndexProgress>,
}

static VEC_INIT: Once = Once::new();

/// 进程级注册 sqlite-vec 扩展，让后续每个 Connection 自动加载 vec0。
fn load_vec_extension() {
    VEC_INIT.call_once(|| unsafe {
        type SqliteExtensionInit = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut c_char,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> c_int;
        let init = std::mem::transmute::<*const (), SqliteExtensionInit>(
            sqlite_vec::sqlite3_vec_init as *const (),
        );
        rusqlite::ffi::sqlite3_auto_extension(Some(init));
    });
}

pub fn db_path(workspace: &Path) -> PathBuf {
    workspace.join(".markio").join("rag.db")
}

impl Db {
    pub fn open(workspace: &Path, embed_dim: usize) -> Result<Self, String> {
        load_vec_extension();
        let dir = workspace.join(".markio");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建 .markio 目录失败：{e}"))?;
        let path = dir.join("rag.db");
        let conn = Connection::open(&path).map_err(|e| format!("打开向量数据库失败：{e}"))?;
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(|e| format!("启用 WAL 失败：{e}"))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(format!("启用 WAL 失败：当前模式为 {journal_mode}"));
        }
        conn.pragma_update(None, "synchronous", "NORMAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();

        let mut db = Db {
            conn,
            embed_dim,
            progress: None,
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<(), String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("开启事务失败：{e}"))?;

        tx.execute_batch(&format!(
            r#"
            CREATE TABLE IF NOT EXISTS schema_meta (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS docs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                mtime INTEGER NOT NULL,
                size INTEGER NOT NULL,
                hash TEXT NOT NULL,
                indexed_at INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'ok'
            );
            CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);

            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                ord INTEGER NOT NULL,
                heading TEXT NOT NULL DEFAULT '',
                char_start INTEGER NOT NULL,
                char_end INTEGER NOT NULL,
                body TEXT NOT NULL,
                token_count INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                body,
                heading UNINDEXED,
                content='chunks',
                content_rowid='id',
                tokenize = 'unicode61 remove_diacritics 0'
            );

            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, body, heading) VALUES (new.id, new.body, new.heading);
            END;
            CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, body, heading) VALUES('delete', old.id, old.body, old.heading);
            END;
            CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, body, heading) VALUES('delete', old.id, old.body, old.heading);
                INSERT INTO chunks_fts(rowid, body, heading) VALUES (new.id, new.body, new.heading);
            END;

            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_doc INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
                to_path TEXT NOT NULL,
                target_label TEXT NOT NULL,
                kind TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_doc);
            CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_path);

            INSERT OR IGNORE INTO schema_meta(k, v) VALUES('schema_version', '{SCHEMA_VERSION}');
            "#
        ))
        .map_err(|e| format!("迁移基础表失败：{e}"))?;

        // 创建向量表；维度由当前 embed_dim 决定，若已存在但维度不同需要重建（外层处理）
        let dim = self.embed_dim.max(1);
        let create_vec = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[{dim}])"
        );
        tx.execute_batch(&create_vec)
            .map_err(|e| format!("创建向量表失败：{e}"))?;

        tx.commit().map_err(|e| format!("提交迁移事务失败：{e}"))?;

        // 维度校验
        let stored: Option<String> = self
            .conn
            .query_row(
                "SELECT v FROM schema_meta WHERE k='embedding_dim'",
                [],
                |r| r.get(0),
            )
            .ok();
        if let Some(s) = stored {
            if let Ok(prev) = s.parse::<usize>() {
                if prev != self.embed_dim {
                    self.rebuild_vector_table()?;
                }
            }
        }
        self.conn
            .execute(
                "INSERT OR REPLACE INTO schema_meta(k, v) VALUES('embedding_dim', ?1)",
                params![self.embed_dim.to_string()],
            )
            .map_err(|e| format!("写 embedding_dim 失败：{e}"))?;
        Ok(())
    }

    /// 当 embedding 维度变化时清空向量表（保留 chunks，下一次索引重建向量）
    pub fn rebuild_vector_table(&mut self) -> Result<(), String> {
        let dim = self.embed_dim.max(1);
        self.conn
            .execute_batch("DROP TABLE IF EXISTS vec_chunks;")
            .map_err(|e| format!("删除向量表失败：{e}"))?;
        self.conn
            .execute_batch(&format!(
                "CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[{dim}])"
            ))
            .map_err(|e| format!("重建向量表失败：{e}"))?;
        // 将所有 docs 标记为 stale，触发下一次重新嵌入
        self.conn
            .execute("UPDATE docs SET status='stale'", [])
            .map_err(|e| format!("标记 stale 失败：{e}"))?;
        Ok(())
    }

    pub fn set_meta(&self, k: &str, v: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO schema_meta(k, v) VALUES(?1, ?2)",
                params![k, v],
            )
            .map_err(|e| format!("写 meta {k} 失败：{e}"))?;
        Ok(())
    }

    pub fn get_meta(&self, k: &str) -> Option<String> {
        self.conn
            .query_row("SELECT v FROM schema_meta WHERE k=?1", params![k], |r| {
                r.get(0)
            })
            .ok()
    }

    pub fn doc_count(&self) -> u32 {
        self.conn
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get::<_, i64>(0))
            .map(|n| n as u32)
            .unwrap_or(0)
    }

    pub fn chunk_count(&self) -> u32 {
        self.conn
            .query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get::<_, i64>(0))
            .map(|n| n as u32)
            .unwrap_or(0)
    }

    pub fn last_indexed_at(&self) -> Option<i64> {
        self.conn
            .query_row("SELECT MAX(indexed_at) FROM docs", [], |r| {
                r.get::<_, Option<i64>>(0)
            })
            .ok()
            .flatten()
    }
}

pub fn db_size(workspace: &Path) -> u64 {
    let p = db_path(workspace);
    std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
}
