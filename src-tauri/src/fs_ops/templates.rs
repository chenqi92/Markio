//! 用户自定义模板：扫描 `<workspace>/.markio/templates/*.md`，解析可选 frontmatter
//! (title / icon / name)，把正文原样回传。占位符 `{{date}}/{{time}}/{{title}}` 由前端
//! 在创建时替换。
//!
//! See parent module `fs_ops` for orientation.

use serde::Serialize;
use std::fs;
use std::path::Path;

use super::walker_io::is_markdown;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTemplate {
    /// 文件名 stem，作为稳定 id。
    pub id: String,
    /// 显示标题：frontmatter `title`，缺省用 stem。
    pub title: String,
    /// 图标名：frontmatter `icon`，缺省空串（前端回退到通用图标）。
    pub icon: String,
    /// 默认文件名（可含占位符）：frontmatter `name`，缺省用 title。
    pub name: String,
    /// 模板正文（frontmatter 之后的部分）。
    pub body: String,
}

fn clean_scalar(v: &str) -> String {
    let v = v.trim();
    let v = v.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(v);
    let v = v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')).unwrap_or(v);
    v.to_string()
}

/// 切出 frontmatter 的顶层 `key: value`（仅标量）与正文。无 frontmatter 时返回空表 + 原文。
fn split_frontmatter(content: &str) -> (Vec<(String, String)>, String) {
    let Some(after_open) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    else {
        return (Vec::new(), content.to_string());
    };
    // 闭合 `---`：`\n---` 之前是 block，之后那一行结束是正文起点。
    let Some(end) = after_open.find("\n---") else {
        return (Vec::new(), content.to_string());
    };
    let block = &after_open[..end];
    let after_marker = end + 1; // 指向 `---`
    let body_start = after_open[after_marker..]
        .find('\n')
        .map(|n| after_marker + n + 1)
        .unwrap_or(after_open.len());
    let body = after_open[body_start..].to_string();

    let mut kv: Vec<(String, String)> = Vec::new();
    for raw in block.lines() {
        let line = raw.trim_end_matches('\r');
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_string();
            if !key.is_empty() {
                kv.push((key, clean_scalar(v)));
            }
        }
    }
    (kv, body)
}

fn fm_get(kv: &[(String, String)], key: &str) -> Option<String> {
    kv.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty())
}

/// 列出仓库 `.markio/templates/` 下的自定义模板，按文件名排序。
pub fn list_user_templates(workspace: &str) -> Vec<UserTemplate> {
    let dir = Path::new(workspace).join(".markio").join("templates");
    let mut out: Vec<UserTemplate> = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else {
        return out;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if !is_markdown(&name) {
            continue;
        }
        let path = e.path();
        if !path.is_file() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let (fm, body) = split_frontmatter(&content);
        let title = fm_get(&fm, "title").unwrap_or_else(|| stem.clone());
        let icon = fm_get(&fm, "icon").unwrap_or_default();
        let default_name = fm_get(&fm, "name").unwrap_or_else(|| title.clone());
        out.push(UserTemplate {
            id: stem,
            title,
            icon,
            name: default_name,
            body,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_ws(name: &str) -> PathBuf {
        let unique = format!(
            "markio-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let ws = std::env::temp_dir().join(unique);
        fs::create_dir_all(&ws).unwrap();
        ws
    }

    #[test]
    fn split_frontmatter_basic() {
        let (fm, body) =
            split_frontmatter("---\ntitle: 会议\nicon: message\n---\n# {{title}}\n正文\n");
        assert_eq!(fm_get(&fm, "title").as_deref(), Some("会议"));
        assert_eq!(fm_get(&fm, "icon").as_deref(), Some("message"));
        assert_eq!(body, "# {{title}}\n正文\n");
    }

    #[test]
    fn split_frontmatter_none() {
        let (fm, body) = split_frontmatter("# 普通\n正文");
        assert!(fm.is_empty());
        assert_eq!(body, "# 普通\n正文");
    }

    #[test]
    fn lists_templates_with_frontmatter() {
        let ws = temp_ws("tpl");
        let tdir = ws.join(".markio").join("templates");
        fs::create_dir_all(&tdir).unwrap();
        fs::write(
            tdir.join("Meeting.md"),
            "---\ntitle: 会议纪要\nicon: message\nname: \"{{date}} 会议\"\n---\n# {{title}}\n",
        )
        .unwrap();
        fs::write(tdir.join("plain.md"), "# 无 frontmatter\n").unwrap();
        // 非 md 忽略
        fs::write(tdir.join("note.txt2"), "x").unwrap();

        let list = list_user_templates(&ws.to_string_lossy());
        assert_eq!(list.len(), 2);
        let meeting = list.iter().find(|t| t.id == "Meeting").unwrap();
        assert_eq!(meeting.title, "会议纪要");
        assert_eq!(meeting.icon, "message");
        assert_eq!(meeting.name, "{{date}} 会议");
        assert_eq!(meeting.body, "# {{title}}\n");
        let plain = list.iter().find(|t| t.id == "plain").unwrap();
        assert_eq!(plain.title, "plain");
        assert_eq!(plain.icon, "");

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn missing_dir_returns_empty() {
        let ws = temp_ws("tpl-empty");
        assert!(list_user_templates(&ws.to_string_lossy()).is_empty());
        let _ = fs::remove_dir_all(&ws);
    }
}
