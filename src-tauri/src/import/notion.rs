//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::path::Path;

use sha2::Digest;

use super::common::*;

pub fn import_notion(src_zip: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_incremental_dest(workspace, "notion")?;
    let mut session = ManifestSession::open(workspace, "notion");
    let file = fs::File::open(src_zip).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败：{e}"))?;
    let mut warnings: Vec<String> = Vec::new();
    let mut count = 0;
    let mut skipped = 0;

    // Notion 文件名带 ` <32位 hash>.md` 后缀
    let strip_hash = regex_like_strip;
    if archive.len() > MAX_IMPORT_ENTRIES {
        warnings.push(format!(
            "zip 含 {} 个 entry，超过上限 {}，仅处理前 {} 个",
            archive.len(),
            MAX_IMPORT_ENTRIES,
            MAX_IMPORT_ENTRIES
        ));
    }
    let mut total_bytes: u64 = 0;
    let limit = archive.len().min(MAX_IMPORT_ENTRIES);
    for i in 0..limit {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        let key = import_key(&format!("notion::{raw_name}"));
        if session.is_known(&key) {
            skipped += 1;
            continue;
        }
        // 去掉前导目录 + 内嵌路径
        let parts: Vec<&str> = raw_name.split('/').collect();
        let base = parts.last().copied().unwrap_or("file").to_string();
        let content = match read_entry_limited(&mut entry) {
            Ok(buf) => buf,
            Err(e) => {
                warnings.push(format!("{raw_name}：{e}"));
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(content.len() as u64);
        if total_bytes > MAX_IMPORT_TOTAL_BYTES {
            warnings.push(format!(
                "已解压超过 {} GB，停止后续 entry",
                MAX_IMPORT_TOTAL_BYTES / 1024 / 1024 / 1024
            ));
            break;
        }
        let cleaned = strip_hash(&base);
        let final_name = sanitize(&cleaned);
        if base.to_ascii_lowercase().ends_with(".md") {
            // 重写 markdown 内的 wiki link
            let text = String::from_utf8_lossy(&content).into_owned();
            let rewritten = rewrite_notion_links(&text);
            let to = unique_child_path(&dest, &final_name);
            fs::write(&to, rewritten).map_err(|e| format!("写文件失败：{e}"))?;
            count += 1;
        } else {
            // 其它资产（图片等）直接落到 imports/<provider>/Assets/
            let assets = dest.join("Assets");
            ensure_dir(&assets)?;
            let to = unique_child_path(&assets, &final_name);
            fs::write(&to, content).map_err(|e| format!("写资产失败：{e}"))?;
        }
        session.record(key);
    }
    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "notion".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
        warnings,
        report_path: None,
    }))
}

fn regex_like_strip(name: &str) -> String {
    // 去掉 ` <32 位十六进制>.md` 这种后缀
    if let Some((head, _)) = name.rsplit_once(' ') {
        // 拆出来的尾段可能形如 "abcdef0123456789...32位.md"
        // 简单判定：包含 . 并且前段长度 ≥ 32 且都是 hex
        let stripped = name.trim_end_matches(".md");
        if let Some((title, tail)) = stripped.rsplit_once(' ') {
            if tail.len() >= 24 && tail.chars().all(|c| c.is_ascii_hexdigit()) {
                let mut out = title.to_string();
                if name.ends_with(".md") {
                    out.push_str(".md");
                }
                return out;
            }
        }
        head.to_string()
    } else {
        name.to_string()
    }
}

fn rewrite_notion_links(text: &str) -> String {
    // 把 [Foo](Foo%20<hash>.md) 改成 [[Foo]]
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(end) = text[i..].find("](") {
                let label_end = i + end;
                let label = &text[i + 1..label_end];
                let url_start = label_end + 2;
                if let Some(url_close) = text[url_start..].find(')') {
                    let url = &text[url_start..url_start + url_close];
                    if url.contains("%20") && url.ends_with(".md") {
                        // 视为 Notion 页面链接
                        out.push_str(&format!("[[{label}]]"));
                        i = url_start + url_close + 1;
                        continue;
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

