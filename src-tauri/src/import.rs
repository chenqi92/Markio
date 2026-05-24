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

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    /// 命中清单跳过的条目数（增量模式下衡量"这次重导有多少是旧的"）。
    #[serde(default)]
    pub skipped: usize,
    pub warnings: Vec<String>,
    pub report_path: Option<String>,
}

// ─── 增量导入清单 ─────────────────────────────────────────────────────
//
// 每个 workspace 下 `.markio/imports.json` 记录每个 provider 已经写入的条目
// 指纹（sha256 截断 16 字符）。再次导入时同指纹的条目被跳过，结果只在固定
// 目录 `imports/<provider>/` 下增量累积——不再每次新建带时间戳的目录。
//
// 指纹的语义由各 importer 自行决定（zip 内文件名 / 文件相对路径 / 标题+正文
// 哈希 等），目的是「同一内容下次还能识别出来」。

#[derive(Debug, Default, Serialize, Deserialize)]
struct ImportManifest {
    #[serde(default)]
    providers: BTreeMap<String, ProviderManifest>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProviderManifest {
    #[serde(default)]
    keys: BTreeSet<String>,
}

fn manifest_path(workspace: &Path) -> PathBuf {
    workspace.join(".markio").join("imports.json")
}

fn load_manifest(workspace: &Path) -> ImportManifest {
    let path = manifest_path(workspace);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_manifest(workspace: &Path, m: &ImportManifest) -> Result<(), String> {
    let path = manifest_path(workspace);
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let s = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| format!("写入导入清单失败：{e}"))
}

fn import_key(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let digest = h.finalize();
    let mut out = String::with_capacity(16);
    for b in &digest[..8] {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// 已有 provider 的增量目标目录 `imports/<provider>/`，不再带时间戳。
fn make_incremental_dest(workspace: &Path, provider: &str) -> Result<PathBuf, String> {
    let dir = workspace.join("imports").join(provider);
    ensure_dir(&dir)?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportDir {
    pub path: String,
    pub provider: String,
    pub stamp: String,
    pub size_bytes: u64,
    pub file_count: usize,
}

/// 扫描 workspace/imports 下符合旧时间戳命名（<provider>-YYYYMMDD-HHMMSS）的目录。
/// 这些是切换到增量导入之前留下的，用户可一键清理。
pub fn list_legacy_import_dirs(workspace: &Path) -> Result<Vec<LegacyImportDir>, String> {
    let root = workspace.join("imports");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((provider, stamp)) = parse_legacy_dir_name(&name) else {
            continue;
        };
        let path = entry.path();
        let (size_bytes, file_count) = dir_size_and_count(&path);
        out.push(LegacyImportDir {
            path: path.to_string_lossy().to_string(),
            provider,
            stamp,
            size_bytes,
            file_count,
        });
    }
    out.sort_by(|a, b| b.stamp.cmp(&a.stamp));
    Ok(out)
}

/// 校验路径确实是 workspace/imports 下的旧时间戳目录，并通过项目的
/// fs_ops::trash_move 移到 .markio/trash（可恢复），避免直接 rm。
pub fn trash_legacy_import_dir(workspace: &Path, path: &Path) -> Result<(), String> {
    let root = workspace.join("imports");
    let resolved = path
        .canonicalize()
        .map_err(|e| format!("路径不存在：{e}"))?;
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("imports 目录不存在：{e}"))?;
    if !resolved.starts_with(&root_canon) {
        return Err("拒绝：路径不在当前仓库 imports 下".into());
    }
    let name = resolved
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if parse_legacy_dir_name(&name).is_none() {
        return Err("不是旧时间戳命名（<provider>-YYYYMMDD-HHMMSS），拒绝清理".into());
    }
    crate::fs_ops::trash_move(
        &workspace.to_string_lossy(),
        &resolved.to_string_lossy(),
    )
}

fn parse_legacy_dir_name(name: &str) -> Option<(String, String)> {
    // <provider>-YYYYMMDD-HHMMSS：尾部 8 位日期 + '-' + 6 位时间 = 15 字符
    if name.len() < 17 {
        return None;
    }
    let stamp_part = &name[name.len() - 15..];
    let bytes = stamp_part.as_bytes();
    if bytes[8] != b'-' {
        return None;
    }
    let date_ok = bytes[..8].iter().all(|b| b.is_ascii_digit());
    let time_ok = bytes[9..].iter().all(|b| b.is_ascii_digit());
    if !date_ok || !time_ok {
        return None;
    }
    let prefix = &name[..name.len() - 16];
    if !prefix.ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let provider = prefix.trim_end_matches('-').to_string();
    if provider.is_empty() {
        return None;
    }
    Some((provider, stamp_part.to_string()))
}

fn dir_size_and_count(dir: &Path) -> (u64, usize) {
    let mut size = 0u64;
    let mut count = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    let mut visited_depth = 0;
    while let Some(p) = stack.pop() {
        visited_depth += 1;
        if visited_depth > 50_000 {
            break; // 安全阀
        }
        let read = match fs::read_dir(&p) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(m) = entry.metadata() {
                    size = size.saturating_add(m.len());
                }
                count += 1;
            }
        }
    }
    (size, count)
}

/// 一次导入会话内对清单的读写状态。在 importer 顶部 `open`，导入完毕
/// `save`；中途用 `is_known` / `record` 判断与追加条目。
struct ManifestSession {
    workspace: PathBuf,
    provider: String,
    known: BTreeSet<String>,
    new_keys: BTreeSet<String>,
}

impl ManifestSession {
    fn open(workspace: &Path, provider: &str) -> Self {
        let manifest = load_manifest(workspace);
        let known = manifest
            .providers
            .get(provider)
            .map(|p| p.keys.clone())
            .unwrap_or_default();
        Self {
            workspace: workspace.to_path_buf(),
            provider: provider.to_string(),
            known,
            new_keys: BTreeSet::new(),
        }
    }
    fn is_known(&self, key: &str) -> bool {
        self.known.contains(key)
    }
    fn record(&mut self, key: String) {
        self.new_keys.insert(key);
    }
    fn save(self) -> Result<(), String> {
        // 重读一次主清单：避免覆盖其它 provider 在并发场景下的写入。
        let mut manifest = load_manifest(&self.workspace);
        let entry = manifest.providers.entry(self.provider).or_default();
        entry.keys.extend(self.known);
        entry.keys.extend(self.new_keys);
        save_manifest(&self.workspace, &manifest)
    }
}

fn finalize_report(mut report: ImportReport) -> ImportReport {
    let report_path = Path::new(&report.dest).join("导入报告.md");
    let mut body = String::new();
    body.push_str("# 导入报告\n\n");
    body.push_str(&format!("- 来源：{}\n", report.provider));
    body.push_str(&format!("- 目标：{}\n", report.dest));
    body.push_str(&format!("- 新增文件：{}\n", report.files));
    if report.skipped > 0 {
        body.push_str(&format!("- 跳过（已存在于导入清单）：{}\n", report.skipped));
    }
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

/// Notion：用户导出的 zip 内是若干 `Page Title hash.md` + 关联资源；
/// 重写 `[文本](Page%20Title%20hash.md)` 为 `[[Page Title]]` 风格。
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

/// Obsidian vault：递归复制 .md + .canvas + Assets 目录；保留 wiki link 不变。
/// 增量：按源相对路径 hash 去重；已写过的文件不会重复写。
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

/// Roam Research：支持 Markdown ZIP 导出。JSON 导出需要 block 树转换，
/// 当前不静默吞掉，返回 warning 提醒用户选择 Markdown 导出。
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

/// Logseq graph：选择 graph 根目录，导入 pages / journals 下的 markdown，
/// 同时复制 assets。`.org` 需要语法转换，当前明确跳过并给 warning。
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
fn copy_dir_incremental(
    root: &Path,
    src: &Path,
    dst: &Path,
    provider: &str,
    session: &mut ManifestSession,
    count: &mut usize,
    skipped: &mut usize,
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
            copy_dir_incremental(root, &from, &to, provider, session, count, skipped, depth + 1)?;
        } else if ft.is_file() {
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            if meta.len() > MAX_IMPORT_ENTRY_BYTES {
                continue;
            }
            // 用相对路径做 key——同源同路径视为同一份内容；改名/移动会重导。
            let rel = from
                .strip_prefix(root)
                .ok()
                .and_then(|p| p.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| from.to_string_lossy().to_string());
            let key = import_key(&format!("{provider}::{rel}"));
            if session.is_known(&key) {
                *skipped += 1;
                continue;
            }
            fs::copy(&from, &to).map_err(|e| format!("复制 {} 失败：{e}", from.display()))?;
            *count += 1;
            session.record(key);
        }
    }
    Ok(())
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

#[allow(clippy::too_many_arguments)]
fn copy_import_file_inc(
    from: &Path,
    to: &Path,
    root: &Path,
    provider: &str,
    session: &mut ManifestSession,
    count: &mut usize,
    skipped: &mut usize,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if *count >= MAX_IMPORT_ENTRIES {
        push_warning_limited(
            warnings,
            format!("已达到单次导入文件上限 {MAX_IMPORT_ENTRIES}，停止复制"),
        );
        return Ok(());
    }
    let rel = from
        .strip_prefix(root)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| from.to_string_lossy().to_string());
    let key = import_key(&format!("{provider}::{rel}"));
    if session.is_known(&key) {
        *skipped += 1;
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
    session.record(key);
    Ok(())
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


/// Bear 导出：`.bearbook` 实质是 zip；解开后 `Markdown` 目录里都是 .md 文件。
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

/// 印象笔记 .enex（XML）→ 一笔记一 markdown。
/// 仅处理 `<note>` / `<title>` / `<content>`。content 是 HTML，转换成 markdown
/// 走极简策略：去掉 ENML 头，剥掉一组标签后保留文本。
pub fn import_evernote(src_enex: &Path, workspace: &Path) -> Result<ImportReport, String> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;
    let dest = make_incremental_dest(workspace, "evernote")?;
    let mut session = ManifestSession::open(workspace, "evernote");
    let text = fs::read_to_string(src_enex).map_err(|e| format!("读取 .enex 失败：{e}"))?;
    let mut reader = Reader::from_str(&text);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut current_tag = String::new();
    let mut title = String::new();
    let mut content = String::new();
    let mut count = 0;
    let mut skipped = 0;
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
                    // 标题 + 正文长度 + 前 200 字 作为指纹，足够区分大多数笔记，
                    // 又能在 ENEX 里识别"同一篇笔记"再次导出的情况。
                    let body_prefix: String = content.chars().take(200).collect();
                    let key = import_key(&format!(
                        "evernote::{title}::{len}::{body_prefix}",
                        len = content.len()
                    ));
                    if session.is_known(&key) {
                        skipped += 1;
                    } else {
                        let stem = if title.is_empty() {
                            format!("note-{}", count + 1)
                        } else {
                            sanitize(&title)
                        };
                        let to = unique_child_path(&dest, &format!("{stem}.md"));
                        let cleaned = enml_to_markdown(&content);
                        fs::write(&to, cleaned).map_err(|e| format!("写笔记失败：{e}"))?;
                        count += 1;
                        session.record(key);
                    }
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
    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "evernote".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
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
    let dest = make_incremental_dest(workspace, "apple-notes")?;
    let mut session = ManifestSession::open(workspace, "apple-notes");
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
    let mut skipped = 0;
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
        // 用 标题 + 正文长度 + 前 200 字 做指纹：Notes 没有稳定 ID，
        // 这个组合在大多数场景下足以识别"同一篇笔记"；编辑过的笔记会被当作
        // 新条目重新落盘（旧的文件不动），用户可自行清理。
        let body_prefix: String = body.chars().take(200).collect();
        let key = import_key(&format!(
            "apple-notes::{title}::{len}::{body_prefix}",
            len = body.len()
        ));
        if session.is_known(&key) {
            skipped += 1;
            continue;
        }
        let stem = if title.is_empty() {
            format!("note-{}", count + 1)
        } else {
            sanitize(title)
        };
        let to = unique_child_path(&dest, &format!("{stem}.md"));
        let md_body = enml_to_markdown(body);
        let md = if title.is_empty() {
            md_body
        } else {
            format!("# {title}\n\n{md_body}")
        };
        fs::write(&to, md).map_err(|e| format!("写笔记失败：{e}"))?;
        count += 1;
        session.record(key);
    }
    if count == 0 && skipped == 0 {
        warnings.push("没有读到任何笔记（Notes.app 为空或权限未授予）".into());
    }
    session.save()?;
    Ok(finalize_report(ImportReport {
        provider: "apple-notes".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        skipped,
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
        let report_path = report.report_path.as_ref().expect("report path");
        assert!(Path::new(report_path).exists());
        assert!(std::fs::read_to_string(report_path)
            .unwrap()
            .contains("org-mode"));

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
        let report_path = report.report_path.as_ref().expect("report path");
        assert!(Path::new(report_path).exists());
        assert!(std::fs::read_to_string(report_path)
            .unwrap()
            .contains("JSON"));

        let _ = std::fs::remove_dir_all(root);
    }
}
