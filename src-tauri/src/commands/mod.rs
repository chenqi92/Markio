//! `#[tauri::command]` 实现按域拆到本模块下的子文件，避免 lib.rs 单文件膨胀。
//!
//! 拆分策略：把跟 lib.rs 私有辅助 (`validate_path` / `AppState` 等) 几乎无耦合的
//! 命令组先抽出；核心 fs / md / workspace / ai_chat 等共享上下文最重的留在 lib.rs。
//! 后续可继续按需扩。
//!
//! lib.rs 通过 `use commands::theme::*;` 等把命令引入作用域，`tauri::generate_handler!`
//! 看到的符号名跟原来一致，对外行为不变。

pub mod agent;
pub mod dropbox;
pub mod gdrive;
pub mod git;
pub mod history;
pub mod icloud;
pub mod import;
pub mod mcp;
pub mod rag;
pub mod rss;
pub mod s3;
pub mod secret;
pub mod theme;
pub mod webdav;
