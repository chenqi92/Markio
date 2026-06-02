//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::path::Path;

use super::common::*;

pub fn import_bear(src_archive: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_incremental_dest(workspace, "bear")?;
    let mut session = ManifestSession::open(workspace, "bear");
    let file = fs::File::open(src_archive).map_err(|e| format!("打开 bear 归档失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败：{e}"))?;
    let mut count = 0;
    let mut skipped = 0;
    let mut warnings: Vec<String> = Vec::new();
    if archive.len() > MAX_IMPORT_ENTRIES {
        warnings.push(format!(
            "归档含 {} 个 entry，仅处理前 {}",
            archive.len(),
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
        let key = import_key(&format!("bear::{raw_name}"));
        if session.is_known(&key) {
            skipped += 1;
            continue;
        }
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
        let safe = sanitize(&base);
        if !raw_name.to_ascii_lowercase().ends_with(".md") {
            let assets = dest.join("Assets");
            ensure_dir(&assets)?;
            let to = unique_child_path(&assets, &safe);
            fs::write(&to, content).map_err(|e| format!("写资产失败：{e}"))?;
        } else {
            let to = unique_child_path(&dest, &safe);
            fs::write(&to, content).map_err(|e| format!("写文件失败：{e}"))?;
            count += 1;
        }
        session.record(key);
    }
    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "bear".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
        warnings,
        report_path: None,
    }))
}
