//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::path::Path;

use super::common::*;

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
    // 用标签栈而非单个 current_tag：<content> 内若有嵌套 HTML 子标签，
    // 子标签的 Start 不会覆盖归类，content 内所有文本仍累计到 content。
    let mut stack: Vec<String> = Vec::new();
    let mut title = String::new();
    let mut content = String::new();
    let mut count = 0;
    let mut skipped = 0;
    let warnings: Vec<String> = Vec::new();
    let in_tag = |stack: &[String], tag: &str| stack.iter().any(|t| t == tag);
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                if name == "note" {
                    title.clear();
                    content.clear();
                }
                stack.push(name);
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
                stack.pop();
            }
            Ok(Event::Text(e)) => {
                let txt = String::from_utf8_lossy(&e.into_inner()).into_owned();
                // content 优先：嵌套在 content 里的纯文本也归到正文
                if in_tag(&stack, "content") {
                    content.push_str(&txt);
                } else if in_tag(&stack, "title") {
                    title.push_str(&txt);
                }
            }
            Ok(Event::CData(e)) => {
                if in_tag(&stack, "content") {
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
pub(super) fn enml_to_markdown(html: &str) -> String {
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
    use crate::import::{import_logseq, import_roam};
    use std::io::Write;
    use std::path::PathBuf;
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
