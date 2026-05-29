//! fs_ops: 本地仓库文件操作的总集。
//!
//! 历史上是单文件 1810 行；按职责拆到子模块以便维护：
//!
//! - `walker_io`    — 文件树遍历 + 原子读写 / 创建 / 重命名 / 删除 / mkdir
//! - `snapshots`    — `.markio/history/` 下的时间线快照
//! - `backlinks`    — `[[wikilink]]` 反链 + 非链接提及
//! - `tokens`       — vault 全量 token 索引（标题 / 内容 / wiki / tag）
//! - `vault_index`  — token 索引 + 文件清单的磁盘持久化与增量重建
//! - `trash`        — `.markio/trash/` 软删除 / 列出 / 恢复 / 清空
//! - `search`       — grep / retrieve_context / list_attachments
//!
//! 外部仍然以 `crate::fs_ops::xxx` 调用：每个子模块的 pub 项通过 `pub use` 重新
//! 导出到本模块根，调用方无需更新路径。
//!
//! 设计原则：
//! - 子模块只做"针对本地 .md 仓库的纯函数"；不持有进程级状态
//! - 工作空间边界 / 路径校验由 `lib.rs` 的 `validate_path` 等做完后再调本模块
//! - 错误统一用 `Result<T, String>`，便于直接抛回 Tauri command

pub mod backlinks;
pub mod search;
pub mod snapshots;
pub mod tokens;
pub mod trash;
pub mod vault_index;
pub mod walker_io;

pub use backlinks::*;
pub use search::*;
pub use snapshots::*;
pub use tokens::*;
pub use trash::*;
pub use vault_index::*;
pub use walker_io::*;
