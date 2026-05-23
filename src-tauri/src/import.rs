// 从第三方笔记应用导入到 markio
//
// 支持：
//   * Notion 导出 zip
//   * Obsidian vault 目录（递归复制 .md + 保留 [[wiki]]）
//   * Roam Research Markdown zip
//   * Logseq graph 目录（复制 pages/journals/assets，跳过暂未转换的 .org）
//   * Bear .bearbook 归档（含 .md）
//   * 印象 .enex XML
//
// 通用约定：
//   * dest_workspace 是已注册的 markio workspace；导入产物落到 `<workspace>/imports/<provider>-<ts>/`
//   * 文件名清洗：保留中英文 / 数字 / -_。其它替换成 `_`
//   * 进度通过 `import-progress` 事件回报，前端订阅

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

// 防 zip-bomb / OOM 的硬上限。桌面应用一次导入的合理量级是 GB 内、文件数 < 数万。
// 命中限制时跳过单个 entry + 加 warning，而不是直接整体失败——已成功的部分有价值。
const MAX_IMPORT_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_IMPORT_ENTRIES: usize = 100_000;
const MAX_IMPORT_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_COPY_DEPTH: usize = 32;

/// 把 entry 读到 buffer，超过单 entry 上限则截断 + 报错。
fn read_entry_limited(entry: &mut zip::read::ZipFile<'_>) -> Result<Vec<u8>, String> {
    let size = entry.size();
    if size > MAX_IMPORT_ENTRY_BYTES {
        return Err(format!(
            "文件超过单体上限 {} MB",
            MAX_IMPORT_ENTRY_BYTES / 1024 / 1024
        ));
    }
    let mut buf = Vec::with_capacity(size.min(8 * 1024 * 1024) as usize);
    entry
        .take(MAX_IMPORT_ENTRY_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败：{e}"))?;
    if buf.len() as u64 > MAX_IMPORT_ENTRY_BYTES {
        return Err(format!(
            "解压后超过单体上限 {} MB（可能是 zip-bomb）",
            MAX_IMPORT_ENTRY_BYTES / 1024 / 1024
        ));
    }
    Ok(buf)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub provider: String,
    pub dest: String,
    pub files: usize,
    pub warnings: Vec<String>,
    pub report_path: Option<String>,
}

fn finalize_report(mut report: ImportReport) -> ImportReport {
    let report_path = Path::new(&report.dest).join("导入报告.md");
    let mut body = String::new();
    body.push_str("# 导入报告\n\n");
    body.push_str(&format!("- 来源：{}\n", report.provider));
    body.push_str(&format!("- 目标：{}\n", report.dest));
    body.push_str(&format!("- 文件数：{}\n", report.files));
    body.push_str(&format!("- 警告数：{}\n\n", report.warnings.len()));
    if report.warnings.is_empty() {
        body.push_str("未产生警告。\n");
    } else {
        body.push_str("## 警告\n\n");
        for warning in &report.warnings {
            body.push_str("- ");
            body.push_str(warning);
            body.push('\n');
        }
    }
    match fs::write(&report_path, body) {
        Ok(()) => report.report_path = Some(report_path.to_string_lossy().to_string()),
        Err(e) => push_warning_limited(&mut report.warnings, format!("写入导入报告失败：{e}")),
    }
    report
}

fn sanitize(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == '.' || ch == ' ' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim().trim_matches('.');
    if trimmed.is_empty() {
        "imported".to_string()
    } else {
        trimmed.to_string()
    }
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| format!("创建目录失败 {}：{e}", p.display()))
}

fn push_warning_limited(warnings: &mut Vec<String>, msg: String) {
    if warnings.len() < 50 {
        warnings.push(msg);
    } else if warnings.len() == 50 {
        warnings.push("后续警告已省略".to_string());
    }
}

fn unique_child_path(dir: &Path, name: &str) -> PathBuf {
    let clean = sanitize(name);
    let candidate = dir.join(&clean);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(&clean);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("imported");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    for i in 2..10_000 {
        let next_name = if ext.is_empty() {
            format!("{stem}-{i}")
        } else {
            format!("{stem}-{i}.{ext}")
        };
        let next = dir.join(next_name);
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}-{}", chrono::Utc::now().timestamp_millis()))
}

fn make_dest(workspace: &Path, provider: &str) -> Result<PathBuf, String> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = workspace
        .join("imports")
        .join(format!("{provider}-{stamp}"));
    ensure_dir(&dir)?;
    Ok(dir)
}

/// Notion：用户导出的 zip 内是若干 `Page Title hash.md` + 关联资源；
/// 重写 `[文本](Page%20Title%20hash.md)` 为 `[[Page Title]]` 风格。
pub fn import_notion(src_zip: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_dest(workspace, "notion")?;
    let file = fs::File::open(src_zip).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败：{e}"))?;
    let mut warnings: Vec<String> = Vec::new();
    let mut count = 0;

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
            fs::write(dest.join(&final_name), rewritten).map_err(|e| format!("写文件失败：{e}"))?;
            count += 1;
        } else {
            // 其它资产（图片等）直接落到 imports/<provider>/Assets/
            let assets = dest.join("Assets");
            ensure_dir(&assets)?;
            fs::write(assets.join(&final_name), content).map_err(|e| format!("写资产失败：{e}"))?;
        }
    }
    Ok(finalize_report(ImportReport {
        provider: "notion".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
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

/// Obsidian vault：直接递归复制 .md + .canvas + Assets 目录；保留 wiki link 不变。
pub fn import_obsidian(src_dir: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_dest(workspace, "obsidian")?;
    let mut count = 0;
    let warnings: Vec<String> = Vec::new();
    copy_dir_recursive(src_dir, &dest, &mut count)?;
    Ok(finalize_report(ImportReport {
        provider: "obsidian".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
        report_path: None,
    }))
}

/// Roam Research：支持 Markdown ZIP 导出。JSON 导出需要 block 树转换，
/// 当前不静默吞掉，返回 warning 提醒用户选择 Markdown 导出。
pub fn import_roam(src_zip: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_dest(workspace, "roam")?;
    let file = fs::File::open(src_zip).map_err(|e| format!("打开 roam zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 roam zip 失败：{e}"))?;
    let mut warnings: Vec<String> = Vec::new();
    let mut count = 0;
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
    }

    if skipped_json {
        push_warning_limited(
            &mut warnings,
            "检测到 Roam JSON 导出；当前仅转换 Markdown ZIP，请在 Roam 导出时选择 Markdown"
                .to_string(),
        );
    }
    if count == 0 {
        push_warning_limited(
            &mut warnings,
            "没有导入任何 Markdown 文件；请确认选择的是 Roam Markdown ZIP".to_string(),
        );
    }

    Ok(finalize_report(ImportReport {
        provider: "roam".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
        report_path: None,
    }))
}

/// Logseq graph：选择 graph 根目录，导入 pages / journals 下的 markdown，
/// 同时复制 assets。`.org` 需要语法转换，当前明确跳过并给 warning。
pub fn import_logseq(src_dir: &Path, workspace: &Path) -> Result<ImportReport, String> {
    if !src_dir.is_dir() {
        return Err("Logseq 导入需要选择 graph 目录".to_string());
    }
    let dest = make_dest(workspace, "logseq")?;
    let mut count = 0;
    let mut warnings: Vec<String> = Vec::new();

    let mut known_sections = 0;
    for section in ["pages", "journals"] {
        let from = src_dir.join(section);
        if from.is_dir() {
            known_sections += 1;
            copy_logseq_markdown_dir(&from, &dest.join(section), &mut count, &mut warnings, 0)?;
        }
    }

    let assets = src_dir.join("assets");
    if assets.is_dir() {
        copy_logseq_assets_dir(&assets, &dest.join("assets"), &mut count, &mut warnings, 0)?;
    }

    for entry in fs::read_dir(src_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if !ft.is_file() {
            continue;
        }
        let from = entry.path();
        if is_markdown_path(&from) {
            copy_import_file(
                &from,
                &dest.join(entry.file_name()),
                &mut count,
                &mut warnings,
            )?;
        } else if is_org_path(&from) {
            push_warning_limited(
                &mut warnings,
                format!("跳过 org-mode 文件：{}", from.display()),
            );
        }
    }

    if known_sections == 0 && count == 0 {
        push_warning_limited(
            &mut warnings,
            "未找到 pages/ 或 journals/，已按普通目录尝试导入 Markdown".to_string(),
        );
        copy_logseq_markdown_dir(src_dir, &dest, &mut count, &mut warnings, 0)?;
    }
    if count == 0 {
        push_warning_limited(
            &mut warnings,
            "没有导入任何 Markdown 或资源文件".to_string(),
        );
    }

    Ok(finalize_report(ImportReport {
        provider: "logseq".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
        report_path: None,
    }))
}

fn copy_dir_recursive(src: &Path, dst: &Path, count: &mut usize) -> Result<(), String> {
    copy_dir_recursive_inner(src, dst, count, 0)
}

fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase()),
        Some(ext) if ext == "md" || ext == "markdown"
    )
}

fn is_org_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase()),
        Some(ext) if ext == "org"
    )
}

fn copy_import_file(
    from: &Path,
    to: &Path,
    count: &mut usize,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if *count >= MAX_IMPORT_ENTRIES {
        push_warning_limited(
            warnings,
            format!("已达到单次导入文件上限 {MAX_IMPORT_ENTRIES}，停止复制"),
        );
        return Ok(());
    }
    let meta = fs::metadata(from).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMPORT_ENTRY_BYTES {
        push_warning_limited(
            warnings,
            format!(
                "跳过超大文件：{}（超过 {} MB）",
                from.display(),
                MAX_IMPORT_ENTRY_BYTES / 1024 / 1024
            ),
        );
        return Ok(());
    }
    if let Some(parent) = to.parent() {
        ensure_dir(parent)?;
    }
    fs::copy(from, to).map_err(|e| format!("复制 {} 失败：{e}", from.display()))?;
    *count += 1;
    Ok(())
}

fn copy_logseq_markdown_dir(
    src: &Path,
    dst: &Path,
    count: &mut usize,
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
            copy_logseq_markdown_dir(&from, &to, count, warnings, depth + 1)?;
        } else if ft.is_file() && is_markdown_path(&from) {
            copy_import_file(&from, &to, count, warnings)?;
        } else if ft.is_file() && is_org_path(&from) {
            push_warning_limited(warnings, format!("跳过 org-mode 文件：{}", from.display()));
        }
    }
    Ok(())
}

fn copy_logseq_assets_dir(
    src: &Path,
    dst: &Path,
    count: &mut usize,
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
            copy_logseq_assets_dir(&from, &to, count, warnings, depth + 1)?;
        } else if ft.is_file() {
            copy_import_file(&from, &to, count, warnings)?;
        }
    }
    Ok(())
}

fn copy_dir_recursive_inner(
    src: &Path,
    dst: &Path,
    count: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "目录深度超过 {MAX_COPY_DEPTH} 层（疑似符号链接死循环）"
        ));
    }
    if *count > MAX_IMPORT_ENTRIES {
        return Err(format!("文件数超过上限 {MAX_IMPORT_ENTRIES}"));
    }
    ensure_dir(dst)?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        // 用 metadata 而非 file_type：metadata 跟随符号链接，能让目标的 is_dir 判断
        // 与 file_type().is_dir() 在 symlink 场景下行为不同；这里我们要拒绝 symlink，
        // 避免 vault 内一个指回上级的链接造成无限递归。
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if ft.is_dir() {
            copy_dir_recursive_inner(&from, &to, count, depth + 1)?;
        } else if ft.is_file() {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            if meta.len() > MAX_IMPORT_ENTRY_BYTES {
                continue; // 超大单文件跳过（图片 vault 偶尔有几百 MB 的 PSD）
            }
            fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败：{e}", from.display()))?;
            *count += 1;
        }
    }
    Ok(())
}

/// Bear 导出：`.bearbook` 实质是 zip；解开后 `Markdown` 目录里都是 .md 文件。
pub fn import_bear(src_archive: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_dest(workspace, "bear")?;
    let file = fs::File::open(src_archive).map_err(|e| format!("打开 bear 归档失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败：{e}"))?;
    let mut count = 0;
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
        if !raw_name.to_ascii_lowercase().ends_with(".md") {
            let assets = dest.join("Assets");
            ensure_dir(&assets)?;
            fs::write(assets.join(sanitize(&base)), content)
                .map_err(|e| format!("写资产失败：{e}"))?;
            continue;
        }
        fs::write(dest.join(sanitize(&base)), content).map_err(|e| format!("写文件失败：{e}"))?;
        count += 1;
    }
    Ok(finalize_report(ImportReport {
        provider: "bear".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
        report_path: None,
    }))
}

/// 印象笔记 .enex（XML）→ 一笔记一 markdown。
/// 仅处理 `<note>` / `<title>` / `<content>`。content 是 HTML，转换成 markdown
/// 走极简策略：去掉 ENML 头，剥掉一组标签后保留文本。
pub fn import_evernote(src_enex: &Path, workspace: &Path) -> Result<ImportReport, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let dest = make_dest(workspace, "evernote")?;
    let text = fs::read_to_string(src_enex).map_err(|e| format!("读取 .enex 失败：{e}"))?;
    let mut reader = Reader::from_str(&text);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut current_tag = String::new();
    let mut title = String::new();
    let mut content = String::new();
    let mut count = 0;
    let warnings: Vec<String> = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                current_tag = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if current_tag == "note" {
                    title.clear();
                    content.clear();
                }
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if name == "note" {
                    let fname = if title.is_empty() {
                        format!("note-{}.md", count + 1)
                    } else {
                        format!("{}.md", sanitize(&title))
                    };
                    let cleaned = enml_to_markdown(&content);
                    fs::write(dest.join(fname), cleaned).map_err(|e| format!("写笔记失败：{e}"))?;
                    count += 1;
                }
                current_tag.clear();
            }
            Ok(Event::Text(e)) => {
                let txt = String::from_utf8_lossy(&e.into_inner()).into_owned();
                match current_tag.as_str() {
                    "title" => title.push_str(&txt),
                    "content" => content.push_str(&txt),
                    _ => {}
                }
            }
            Ok(Event::CData(e)) => {
                if current_tag == "content" {
                    content.push_str(&String::from_utf8_lossy(&e.into_inner()));
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 .enex 失败：{e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(finalize_report(ImportReport {
        provider: "evernote".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
        report_path: None,
    }))
}

/// Apple Notes 导入（macOS 专属）：通过 osascript 走 Apple Events 让 Notes.app
/// 自己导出标题 + HTML body，再把 HTML 简化成 markdown 落盘。
///
/// 优点：
///   - 不直接读 ~/Library/Containers 里的 protobuf+zlib 加密格式（脆且违反沙盒）
///   - 由 Notes.app 自己解密 / 渲染，加密笔记会被自然跳过（用户不会被静默漏掉解密笔记）
///
/// 缺点：
///   - 首次调用会弹系统对话框「markio 想访问 Notes 数据」，要用户批准
///   - 大量笔记（>1000）osascript 耗时可能十几秒，由前端给 spinner
#[cfg(target_os = "macos")]
pub fn import_apple_notes(workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_dest(workspace, "apple-notes")?;
    // 使用清晰的多字符 delimiter，避免与笔记内容冲突
    let script = r#"on run
  set out to ""
  set sep1 to "---MK-NOTE-SEP---"
  set sep2 to "---MK-BODY-SEP---"
  tell application "Notes"
    set allNotes to every note
    repeat with n in allNotes
      try
        set t to name of n
        set b to body of n
        set out to out & sep1 & return & t & return & sep2 & return & b & return
      on error
        -- 加密 / 锁定的笔记跳过
      end try
    end repeat
  end tell
  return out
end run
"#;
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("调用 osascript 失败：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Notes.app 读取失败：{err}"));
    }
    let text = String::from_utf8_lossy(&output.stdout).into_owned();

    let mut warnings: Vec<String> = Vec::new();
    let mut count = 0;
    // 用 NOTE-SEP 切片，每片再用 BODY-SEP 拆 title / html
    for chunk in text.split("---MK-NOTE-SEP---") {
        let trimmed = chunk.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.splitn(2, "---MK-BODY-SEP---");
        let title = parts.next().map(|s| s.trim()).unwrap_or("");
        let body = parts.next().map(|s| s.trim()).unwrap_or("");
        if title.is_empty() && body.is_empty() {
            continue;
        }
        if count >= MAX_IMPORT_ENTRIES {
            warnings.push(format!("已达单次导入上限 {MAX_IMPORT_ENTRIES} 篇"));
            break;
        }
        let fname = if title.is_empty() {
            format!("note-{}.md", count + 1)
        } else {
            format!("{}.md", sanitize(title))
        };
        let md_body = enml_to_markdown(body);
        let md = if title.is_empty() {
            md_body
        } else {
            format!("# {title}\n\n{md_body}")
        };
        fs::write(dest.join(fname), md).map_err(|e| format!("写笔记失败：{e}"))?;
        count += 1;
    }
    if count == 0 {
        warnings.push("没有读到任何笔记（Notes.app 为空或权限未授予）".into());
    }
    Ok(finalize_report(ImportReport {
        provider: "apple-notes".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
        report_path: None,
    }))
}

#[cfg(not(target_os = "macos"))]
pub fn import_apple_notes(_workspace: &Path) -> Result<ImportReport, String> {
    Err("Apple Notes 导入仅在 macOS 可用".into())
}

fn enml_to_markdown(html: &str) -> String {
    // 极简：剥所有 <tag>，连续空白合并为单个换行
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut prev_was_block = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            // 简单处理：</p> </div> </br> 等当换行
            if !prev_was_block {
                out.push('\n');
                prev_was_block = true;
            }
            continue;
        }
        if in_tag {
            continue;
        }
        if ch == '\r' {
            continue;
        }
        out.push(ch);
        if !ch.is_whitespace() {
            prev_was_block = false;
        }
    }
    // 折叠多空行
    let mut collapsed = String::with_capacity(out.len());
    let mut newline_run = 0;
    for ch in out.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                collapsed.push(ch);
            }
        } else {
            newline_run = 0;
            collapsed.push(ch);
        }
    }
    collapsed.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "markio-import-{name}-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn import_logseq_copies_pages_journals_and_assets() {
        let root = temp_root("logseq");
        let graph = root.join("graph");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(graph.join("pages")).unwrap();
        std::fs::create_dir_all(graph.join("journals")).unwrap();
        std::fs::create_dir_all(graph.join("assets")).unwrap();
        std::fs::create_dir_all(graph.join("logseq")).unwrap();

        std::fs::write(graph.join("pages").join("Project.md"), "- hello").unwrap();
        std::fs::write(graph.join("journals").join("2026_05_18.md"), "- journal").unwrap();
        std::fs::write(graph.join("assets").join("image.png"), [1_u8, 2, 3]).unwrap();
        std::fs::write(graph.join("pages").join("Legacy.org"), "* org").unwrap();
        std::fs::write(graph.join("logseq").join("config.edn"), "{}").unwrap();

        let report = import_logseq(&graph, &workspace).unwrap();
        let dest = PathBuf::from(&report.dest);

        assert_eq!(report.provider, "logseq");
        assert_eq!(report.files, 3);
        assert!(dest.join("pages").join("Project.md").exists());
        assert!(dest.join("journals").join("2026_05_18.md").exists());
        assert!(dest.join("assets").join("image.png").exists());
        assert!(!dest.join("pages").join("Legacy.org").exists());
        assert!(!dest.join("logseq").join("config.edn").exists());
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("org-mode")));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn import_roam_copies_markdown_zip_and_warns_for_json() {
        let root = temp_root("roam");
        let archive_path = root.join("roam.zip");
        let workspace = root.join("workspace");

        let file = std::fs::File::create(&archive_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("Page.md", options).unwrap();
        zip.write_all(b"# Page").unwrap();
        zip.start_file("nested/Page.md", options).unwrap();
        zip.write_all(b"# Duplicate").unwrap();
        zip.start_file("roam.json", options).unwrap();
        zip.write_all(br#"[]"#).unwrap();
        zip.finish().unwrap();

        let report = import_roam(&archive_path, &workspace).unwrap();
        let dest = PathBuf::from(&report.dest);

        assert_eq!(report.provider, "roam");
        assert_eq!(report.files, 2);
        assert!(dest.join("Page.md").exists());
        assert!(dest.join("Page-2.md").exists());
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("JSON")));

        let _ = std::fs::remove_dir_all(root);
    }
}
