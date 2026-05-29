//! See parent module `import` for orientation. Split out from the original
//! 1399-line `import.rs` so each provider lives in its own file.

use std::fs;
use std::io::Read;
use std::path::Path;

use sha2::Digest;

use super::common::*;
use super::evernote::enml_to_markdown;

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

