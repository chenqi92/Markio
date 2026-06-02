//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::path::Path;

use super::common::*;

pub fn import_logseq(src_dir: &Path, workspace: &Path) -> Result<ImportReport, String> {
    if !src_dir.is_dir() {
        return Err("Logseq 导入需要选择 graph 目录".to_string());
    }
    let dest = make_incremental_dest(workspace, "logseq")?;
    let mut session = ManifestSession::open(workspace, "logseq");
    let mut count = 0;
    let mut skipped = 0;
    let mut warnings: Vec<String> = Vec::new();

    let mut known_sections = 0;
    for section in ["pages", "journals"] {
        let from = src_dir.join(section);
        if from.is_dir() {
            known_sections += 1;
            copy_logseq_markdown_dir(
                &from,
                &dest.join(section),
                src_dir,
                "logseq",
                &mut session,
                &mut count,
                &mut skipped,
                &mut warnings,
                0,
            )?;
        }
    }

    let assets = src_dir.join("assets");
    if assets.is_dir() {
        copy_logseq_assets_dir(
            &assets,
            &dest.join("assets"),
            src_dir,
            "logseq",
            &mut session,
            &mut count,
            &mut skipped,
            &mut warnings,
            0,
        )?;
    }

    for entry in fs::read_dir(src_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if !ft.is_file() {
            continue;
        }
        let from = entry.path();
        if is_markdown_path(&from) {
            copy_import_file_inc(
                &from,
                &dest.join(entry.file_name()),
                src_dir,
                "logseq",
                &mut session,
                &mut count,
                &mut skipped,
                &mut warnings,
            )?;
        } else if is_org_path(&from) {
            push_warning_limited(
                &mut warnings,
                format!("跳过 org-mode 文件：{}", from.display()),
            );
        }
    }

    if known_sections == 0 && count == 0 && skipped == 0 {
        push_warning_limited(
            &mut warnings,
            "未找到 pages/ 或 journals/，已按普通目录尝试导入 Markdown".to_string(),
        );
        copy_logseq_markdown_dir(
            src_dir,
            &dest,
            src_dir,
            "logseq",
            &mut session,
            &mut count,
            &mut skipped,
            &mut warnings,
            0,
        )?;
    }
    if count == 0 && skipped == 0 {
        push_warning_limited(
            &mut warnings,
            "没有导入任何 Markdown 或资源文件".to_string(),
        );
    }

    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "logseq".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
        warnings,
        report_path: None,
    }))
}

#[allow(clippy::too_many_arguments)]
fn copy_logseq_markdown_dir(
    src: &Path,
    dst: &Path,
    root: &Path,
    provider: &str,
    session: &mut ManifestSession,
    count: &mut usize,
    skipped: &mut usize,
    warnings: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        push_warning_limited(
            warnings,
            format!(
                "跳过过深目录：{}（超过 {MAX_COPY_DEPTH} 层）",
                src.display()
            ),
        );
        return Ok(());
    }
    ensure_dir(dst)?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "logseq" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if ft.is_symlink() {
            push_warning_limited(warnings, format!("跳过符号链接：{}", from.display()));
            continue;
        }
        if ft.is_dir() {
            copy_logseq_markdown_dir(
                &from,
                &to,
                root,
                provider,
                session,
                count,
                skipped,
                warnings,
                depth + 1,
            )?;
        } else if ft.is_file() && is_markdown_path(&from) {
            copy_import_file_inc(
                &from, &to, root, provider, session, count, skipped, warnings,
            )?;
        } else if ft.is_file() && is_org_path(&from) {
            push_warning_limited(warnings, format!("跳过 org-mode 文件：{}", from.display()));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn copy_logseq_assets_dir(
    src: &Path,
    dst: &Path,
    root: &Path,
    provider: &str,
    session: &mut ManifestSession,
    count: &mut usize,
    skipped: &mut usize,
    warnings: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        push_warning_limited(
            warnings,
            format!(
                "跳过过深资源目录：{}（超过 {MAX_COPY_DEPTH} 层）",
                src.display()
            ),
        );
        return Ok(());
    }
    ensure_dir(dst)?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if ft.is_symlink() {
            push_warning_limited(warnings, format!("跳过符号链接：{}", from.display()));
            continue;
        }
        if ft.is_dir() {
            copy_logseq_assets_dir(
                &from,
                &to,
                root,
                provider,
                session,
                count,
                skipped,
                warnings,
                depth + 1,
            )?;
        } else if ft.is_file() {
            copy_import_file_inc(
                &from, &to, root, provider, session, count, skipped, warnings,
            )?;
        }
    }
    Ok(())
}
