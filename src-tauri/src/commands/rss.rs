//! 单条 RSS 抓取（http/https URL 解析 + 条目大小限制在 rss 模块里做）。

use crate::rss;

#[tauri::command]
pub async fn rss_fetch(url: String) -> Result<rss::RssFetchResult, String> {
    // 只放行 http/https；Rust 端做了 URL parse + scheme 检查 + body 大小 + 条目数上限
    rss::fetch(&url).await
}
