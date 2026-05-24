//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::path::Path;

use sha2::Digest;

use super::common::*;

pub fn import_roam(src_zip: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_incremental_dest(workspace, "roam")?;
    let mut session = ManifestSession::open(workspace, "roam");
    let file = fs::File::open(src_zip).map_err(|e| format!("打开 roam zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 roam zip 失败：{e}"))?;
    let mut warnings: Vec<String> = Vec::new();
    let mut count = 0;
    let mut skipped = 0;
    let mut total_bytes: u64 = 0;
    let mut skipped_json = false;

    if archive.len() > MAX_IMPORT_ENTRIES {
        warnings.push(format!(
            "zip 含 {} 个 entry，超过上限 {}，仅处理前 {} 个",
            archive.len(),
            MAX_IMPORT_ENTRIES,
            MAX_IMPORT_ENTRIES
        ));
    }

    let limit = archive.len().min(MAX_IMPORT_ENTRIES);
    for i in 0..limit {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        let base = raw_name.rsplit('/').next().unwrap_or("file").to_string();
        if base.is_empty() || base.starts_with('.') {
            continue;
        }
        let path = Path::new(&base);
        let is_markdown = is_markdown_path(path);
        let is_json = matches!(
            path.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase()),
            Some(ext) if ext == "json"
        );
        if !is_markdown && !is_json {
            continue;
        }
        let key = import_key(&format!("roam::{raw_name}"));
        if is_markdown && session.is_known(&key) {
            skipped += 1;
            continue;
        }
        let content = match read_entry_limited(&mut entry) {
            Ok(buf) => buf,
            Err(e) => {
                push_warning_limited(&mut warnings, format!("{raw_name}：{e}"));
                continue;
            }
        };
        total_bytes = total_bytes.saturating_add(content.len() as u64);
        if total_bytes > MAX_IMPORT_TOTAL_BYTES {
            push_warning_limited(
                &mut warnings,
                format!(
                    "已解压超过 {} GB，停止后续 entry",
                    MAX_IMPORT_TOTAL_BYTES / 1024 / 1024 / 1024
                ),
            );
            break;
        }

        if is_json {
            skipped_json = true;
            continue;
        }

        let to = unique_child_path(&dest, &base);
        fs::write(to, content).map_err(|e| format!("写 roam markdown 失败：{e}"))?;
        count += 1;
        session.record(key);
    }

    if skipped_json {
        push_warning_limited(
            &mut warnings,
            "检测到 Roam JSON 导出；当前仅转换 Markdown ZIP，请在 Roam 导出时选择 Markdown"
                .to_string(),
        );
    }
    if count == 0 && skipped == 0 {
        push_warning_limited(
            &mut warnings,
            "没有导入任何 Markdown 文件；请确认选择的是 Roam Markdown ZIP".to_string(),
        );
    }

    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "roam".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
        warnings,
        report_path: None,
    }))
}

