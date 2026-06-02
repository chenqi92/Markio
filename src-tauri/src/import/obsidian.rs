//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::path::Path;

use super::common::*;

pub fn import_obsidian(src_dir: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_incremental_dest(workspace, "obsidian")?;
    let mut session = ManifestSession::open(workspace, "obsidian");
    let mut count = 0;
    let mut skipped = 0;
    let warnings: Vec<String> = Vec::new();
    copy_dir_incremental(
        src_dir,
        src_dir,
        &dest,
        "obsidian",
        &mut session,
        &mut count,
        &mut skipped,
        0,
    )?;
    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "obsidian".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
        warnings,
        report_path: None,
    }))
}
