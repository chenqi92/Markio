//! 从第三方笔记应用导入到 markio。
//!
//! 历史上是单文件 1399 行；按 provider 拆到子模块以便维护：
//!
//! - `common`       共享：常量 / ImportReport / ImportManifest / LegacyImportDir /
//!                  sanitize / unique_child_path / copy_dir_incremental /
//!                  is_markdown_path / is_org_path / ManifestSession / finalize_report
//! - `notion`       Notion 导出 zip + `[[wiki]]` 链接重写
//! - `obsidian`     Obsidian vault 目录递归复制
//! - `roam`         Roam Research Markdown zip
//! - `logseq`       Logseq graph 目录 (pages / journals / assets)
//! - `bear`         Bear `.bearbook` 归档
//! - `evernote`     `.enex` XML + ENML 极简 → markdown 转换
//! - `apple_notes`  macOS 专属，走 osascript + Apple Events
//!
//! 外部仍以 `crate::import::xxx` 调用：每个子模块的 pub 项通过 `pub use`
//! 重新导出到本模块根，调用方无需更新路径。

pub mod apple_notes;
pub mod bear;
pub mod common;
pub mod evernote;
pub mod logseq;
pub mod notion;
pub mod obsidian;
pub mod roam;

pub use apple_notes::*;
pub use bear::*;
pub use common::*;
pub use evernote::*;
pub use logseq::*;
pub use notion::*;
pub use obsidian::*;
pub use roam::*;
