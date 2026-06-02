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
pub(super) const MAX_IMPORT_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
pub(super) const MAX_IMPORT_ENTRIES: usize = 100_000;
pub(super) const MAX_IMPORT_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(super) const MAX_COPY_DEPTH: usize = 32;

/// 把 entry 读到 buffer，超过单 entry 上限则截断 + 报错。
pub(super) fn read_entry_limited(entry: &mut zip::read::ZipFile<'_>) -> Result<Vec<u8>, String> {
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
pub(super) struct ImportManifest {
    #[serde(default)]
    providers: BTreeMap<String, ProviderManifest>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProviderManifest {
    #[serde(default)]
    keys: BTreeSet<String>,
}

pub(super) fn manifest_path(workspace: &Path) -> PathBuf {
    workspace.join(".markio").join("imports.json")
}

pub(super) fn load_manifest(workspace: &Path) -> ImportManifest {
    let path = manifest_path(workspace);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(super) fn save_manifest(workspace: &Path, m: &ImportManifest) -> Result<(), String> {
    let path = manifest_path(workspace);
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let s = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    fs::write(&path, s).map_err(|e| format!("写入导入清单失败：{e}"))
}

pub(super) fn import_key(s: &str) -> String {
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
pub(super) fn make_incremental_dest(workspace: &Path, provider: &str) -> Result<PathBuf, String> {
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
    crate::fs_ops::trash_move(&workspace.to_string_lossy(), &resolved.to_string_lossy())
}

pub(super) fn parse_legacy_dir_name(name: &str) -> Option<(String, String)> {
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

pub(super) fn dir_size_and_count(dir: &Path) -> (u64, usize) {
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
pub(super) struct ManifestSession {
    workspace: PathBuf,
    provider: String,
    known: BTreeSet<String>,
    new_keys: BTreeSet<String>,
}

impl ManifestSession {
    pub(super) fn open(workspace: &Path, provider: &str) -> Self {
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
    pub(super) fn is_known(&self, key: &str) -> bool {
        self.known.contains(key)
    }
    pub(super) fn record(&mut self, key: String) {
        self.new_keys.insert(key);
    }
    pub(super) fn save(self) -> Result<(), String> {
        // 重读一次主清单：避免覆盖其它 provider 在并发场景下的写入。
        let mut manifest = load_manifest(&self.workspace);
        let entry = manifest.providers.entry(self.provider).or_default();
        entry.keys.extend(self.known);
        entry.keys.extend(self.new_keys);
        save_manifest(&self.workspace, &manifest)
    }
}

pub(super) fn finalize_report(mut report: ImportReport) -> ImportReport {
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

pub(super) fn sanitize(name: &str) -> String {
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

pub(super) fn ensure_dir(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| format!("创建目录失败 {}：{e}", p.display()))
}

pub(super) fn push_warning_limited(warnings: &mut Vec<String>, msg: String) {
    if warnings.len() < 50 {
        warnings.push(msg);
    } else if warnings.len() == 50 {
        warnings.push("后续警告已省略".to_string());
    }
}

pub(super) fn unique_child_path(dir: &Path, name: &str) -> PathBuf {
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
#[allow(clippy::too_many_arguments)]
pub(super) fn copy_dir_incremental(
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
            copy_dir_incremental(
                root,
                &from,
                &to,
                provider,
                session,
                count,
                skipped,
                depth + 1,
            )?;
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

pub(super) fn is_markdown_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase()),
        Some(ext) if ext == "md" || ext == "markdown"
    )
}

pub(super) fn is_org_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase()),
        Some(ext) if ext == "org"
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn copy_import_file_inc(
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
