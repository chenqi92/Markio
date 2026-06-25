//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::path::Path;

use serde::Deserialize;

use super::common::*;

#[derive(Deserialize)]
struct RoamPage {
    title: Option<String>,
    #[serde(default)]
    children: Vec<RoamBlock>,
}

#[derive(Deserialize)]
struct RoamBlock {
    string: Option<String>,
    #[serde(default)]
    children: Vec<RoamBlock>,
    heading: Option<u8>,
}

/// Roam `{{[[TODO]]}}` / `{{[[DONE]]}}` 块 → markdown 任务勾选；返回 (勾选前缀, 去标记文本)。
fn roam_todo(s: &str) -> (String, String) {
    let trimmed = s.trim_start();
    for (marker, mark) in [
        ("{{[[TODO]]}}", "[ ] "),
        ("{{TODO}}", "[ ] "),
        ("{{[[DONE]]}}", "[x] "),
        ("{{DONE}}", "[x] "),
    ] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            return (mark.to_string(), rest.trim_start().to_string());
        }
    }
    (String::new(), s.to_string())
}

fn render_block(block: &RoamBlock, depth: usize, out: &mut String) {
    let s = block.string.as_deref().unwrap_or("").trim_end();
    // heading 块渲染成 markdown 标题；其子块从 depth 0 重新缩进
    if let Some(h) = block.heading.filter(|h| (1..=6).contains(h)) {
        if !s.is_empty() {
            out.push_str(&format!("{} {}\n\n", "#".repeat(h as usize), s));
        }
        for c in &block.children {
            render_block(c, 0, out);
        }
        return;
    }
    let (todo, text) = roam_todo(s);
    if !text.is_empty() || !block.children.is_empty() {
        let indent = "  ".repeat(depth);
        out.push_str(&format!("{indent}- {todo}{text}\n"));
    }
    for c in &block.children {
        render_block(c, depth + 1, out);
    }
}

/// 把 Roam JSON 导出（页面数组）转成 (文件名, markdown) 列表。
/// 块树 → 嵌套 bullet；heading 块 → 标题；TODO/DONE → 任务勾选。
/// `[[link]]` / `#tag` 与 Markio 兼容，原样保留。
pub fn convert_roam_json(json: &str) -> Result<Vec<(String, String)>, String> {
    let pages: Vec<RoamPage> =
        serde_json::from_str(json).map_err(|e| format!("解析 Roam JSON 失败：{e}"))?;
    let mut out = Vec::new();
    for page in pages {
        let title = page.title.unwrap_or_default();
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        let mut body = format!("# {title}\n\n");
        for block in &page.children {
            render_block(block, 0, &mut body);
        }
        out.push((format!("{}.md", sanitize(title)), body));
    }
    Ok(out)
}

pub fn import_roam(src_zip: &Path, workspace: &Path) -> Result<ImportReport, String> {
    let dest = make_incremental_dest(workspace, "roam")?;
    let mut session = ManifestSession::open(workspace, "roam");
    let file = fs::File::open(src_zip).map_err(|e| format!("打开 roam zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 roam zip 失败：{e}"))?;
    let mut warnings: Vec<String> = Vec::new();
    let mut count = 0;
    let mut skipped = 0;
    let mut total_bytes: u64 = 0;

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
            // Roam JSON 导出：一个 .json 含全部页面，转换成多个 .md
            let text = String::from_utf8_lossy(&content);
            match convert_roam_json(&text) {
                Ok(pages) => {
                    for (filename, md) in pages {
                        let to = unique_child_path(&dest, &filename);
                        match fs::write(&to, md) {
                            Ok(()) => count += 1,
                            Err(e) => push_warning_limited(
                                &mut warnings,
                                format!("写 {filename} 失败：{e}"),
                            ),
                        }
                    }
                }
                Err(e) => push_warning_limited(&mut warnings, format!("{raw_name}：{e}")),
            }
            continue;
        }

        let to = unique_child_path(&dest, &base);
        fs::write(to, content).map_err(|e| format!("写 roam markdown 失败：{e}"))?;
        count += 1;
        session.record(key);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_pages_and_nested_blocks() {
        let json = r#"[
          {"title":"Hello","children":[
            {"string":"top","children":[
              {"string":"child"}
            ]}
          ]},
          {"title":"World","children":[{"string":"solo"}]}
        ]"#;
        let pages = convert_roam_json(json).unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].0, "Hello.md");
        assert_eq!(pages[0].1, "# Hello\n\n- top\n  - child\n");
        assert_eq!(pages[1].1, "# World\n\n- solo\n");
    }

    #[test]
    fn heading_block_becomes_markdown_heading() {
        let json = r#"[{"title":"H","children":[
          {"string":"Section","heading":2,"children":[{"string":"point"}]}
        ]}]"#;
        let pages = convert_roam_json(json).unwrap();
        assert_eq!(pages[0].1, "# H\n\n## Section\n\n- point\n");
    }

    #[test]
    fn todo_blocks_become_checkboxes() {
        let json = r#"[{"title":"T","children":[
          {"string":"{{[[TODO]]}} do it"},
          {"string":"{{[[DONE]]}} done it"}
        ]}]"#;
        let pages = convert_roam_json(json).unwrap();
        assert_eq!(pages[0].1, "# T\n\n- [ ] do it\n- [x] done it\n");
    }

    #[test]
    fn keeps_wikilinks_and_tags() {
        let json = r#"[{"title":"L","children":[{"string":"see [[Other]] and #tag"}]}]"#;
        let pages = convert_roam_json(json).unwrap();
        assert!(pages[0].1.contains("- see [[Other]] and #tag"));
    }

    #[test]
    fn skips_untitled_pages_and_sanitizes_names() {
        let json = r#"[
          {"title":"","children":[{"string":"x"}]},
          {"title":"a/b:c","children":[{"string":"y"}]}
        ]"#;
        let pages = convert_roam_json(json).unwrap();
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].0, "a_b_c.md");
    }

    #[test]
    fn invalid_json_errors() {
        assert!(convert_roam_json("not json").is_err());
    }
}
