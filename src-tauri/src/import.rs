// 从第三方笔记应用导入到 markio
//
// 支持：
//   * Notion 导出 zip
//   * Obsidian vault 目录（递归复制 .md + 保留 [[wiki]]）
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub provider: String,
    pub dest: String,
    pub files: usize,
    pub warnings: Vec<String>,
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
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        // 去掉前导目录 + 内嵌路径
        let parts: Vec<&str> = raw_name.split('/').collect();
        let base = parts.last().copied().unwrap_or("file").to_string();
        let mut content = Vec::new();
        if entry.read_to_end(&mut content).is_err() {
            warnings.push(format!("读取失败：{raw_name}"));
            continue;
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
    Ok(ImportReport {
        provider: "notion".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
    })
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
    Ok(ImportReport {
        provider: "obsidian".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
    })
}

fn copy_dir_recursive(src: &Path, dst: &Path, count: &mut usize) -> Result<(), String> {
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
        if ft.is_dir() {
            copy_dir_recursive(&from, &to, count)?;
        } else if ft.is_file() {
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
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        let parts: Vec<&str> = raw_name.split('/').collect();
        let base = parts.last().copied().unwrap_or("file").to_string();
        if !raw_name.to_ascii_lowercase().ends_with(".md") {
            // 资产
            let mut content = Vec::new();
            if entry.read_to_end(&mut content).is_err() {
                warnings.push(format!("读取失败：{raw_name}"));
                continue;
            }
            let assets = dest.join("Assets");
            ensure_dir(&assets)?;
            fs::write(assets.join(sanitize(&base)), content)
                .map_err(|e| format!("写资产失败：{e}"))?;
            continue;
        }
        let mut content = Vec::new();
        if entry.read_to_end(&mut content).is_err() {
            warnings.push(format!("读取失败：{raw_name}"));
            continue;
        }
        fs::write(dest.join(sanitize(&base)), content).map_err(|e| format!("写文件失败：{e}"))?;
        count += 1;
    }
    Ok(ImportReport {
        provider: "bear".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
    })
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
    Ok(ImportReport {
        provider: "evernote".to_string(),
        dest: dest.to_string_lossy().to_string(),
        files: count,
        warnings,
    })
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
