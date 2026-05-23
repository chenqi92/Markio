use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::fs_ops;

/// 一条笔记的 frontmatter 投射（已展开成 key → Vec<value>，
/// 这样 list 字段和单值字段统一处理；空值过滤掉）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFrontmatter {
    pub path: String,
    pub name: String,
    pub fields: BTreeMap<String, Vec<String>>,
}

/// 极简 YAML frontmatter 解析。支持：
///   key: value
///   key: "value with spaces"
///   key: [a, b, c]
///   key:
///     - a
///     - b
/// 不支持嵌套对象、多行 |、>、锚点等高级语法。够 frontmatter-as-tags 用。
fn parse_frontmatter(source: &str) -> Option<BTreeMap<String, Vec<String>>> {
    let body = source.strip_prefix("---\n").or_else(|| source.strip_prefix("---\r\n"))?;
    let end = body.find("\n---")?;
    let block = &body[..end];

    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut cur_key: Option<String> = None;
    let mut cur_list: Vec<String> = Vec::new();

    for raw in block.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            // list item: `  - foo` / `  - "bar"`
            if let Some(item) = line.trim_start().strip_prefix("- ") {
                if let Some(k) = cur_key.as_ref() {
                    let v = clean_scalar(item);
                    if !v.is_empty() {
                        cur_list.push(v);
                    }
                    let _ = k; // suppress unused
                    continue;
                }
            }
            // 其他缩进行（嵌套对象、多行字符串）暂忽略
            continue;
        }

        // 新顶层 key，先把上一个 list flush 掉
        if let Some(k) = cur_key.take() {
            if !cur_list.is_empty() {
                out.entry(k).or_default().extend(cur_list.drain(..));
            }
        }

        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        if key.is_empty() || !key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            // block-style list 接下来几行
            cur_key = Some(key);
            cur_list.clear();
            continue;
        }
        // 行内 list: [a, b, c]
        if let Some(inner) = value.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let items: Vec<String> = inner
                .split(',')
                .map(|s| clean_scalar(s.trim()))
                .filter(|s| !s.is_empty())
                .collect();
            if !items.is_empty() {
                out.insert(key, items);
            }
            continue;
        }
        let cleaned = clean_scalar(value);
        if !cleaned.is_empty() {
            out.insert(key, vec![cleaned]);
        }
    }
    // flush 末尾 list
    if let Some(k) = cur_key.take() {
        if !cur_list.is_empty() {
            out.entry(k).or_default().extend(cur_list);
        }
    }

    Some(out)
}

/// 去掉两侧引号、注释。
fn clean_scalar(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // 去尾注释（粗略：YAML 里 # 前需有空格才算注释，否则可能是 hex 色值之类）
    if let Some(idx) = s.find(" #") {
        s.truncate(idx);
        s = s.trim().to_string();
    }
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s = s[1..s.len() - 1].to_string();
    }
    s
}

/// 扫描 workspace 里所有 .md 文件，抽取 frontmatter。
/// 跳过 .markio/ 隐藏目录与超大文件（>1 MB；frontmatter 不会那么大）。
pub fn scan(workspace: &str) -> Result<Vec<NoteFrontmatter>, String> {
    let ws = PathBuf::from(workspace);
    if !ws.is_dir() {
        return Err("仓库路径无效".into());
    }
    let mut out: Vec<NoteFrontmatter> = Vec::new();
    walk(&ws, &ws, &mut out, 0)?;
    Ok(out)
}

fn walk(
    ws: &Path,
    dir: &Path,
    out: &mut Vec<NoteFrontmatter>,
    depth: usize,
) -> Result<(), String> {
    if depth > 12 {
        return Ok(());
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    for entry in read.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk(ws, &path, out, depth + 1)?;
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > 1_000_000 {
            continue;
        }
        let text = match fs_ops::read_text(&path.to_string_lossy()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let Some(fields) = parse_frontmatter(&text) else {
            continue;
        };
        if fields.is_empty() {
            continue;
        }
        out.push(NoteFrontmatter {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or(name),
            fields,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inline_list() {
        let src = "---\ntitle: Hello\ntags: [a, b, \"c d\"]\nstatus: todo\n---\nbody";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(fm["title"], vec!["Hello".to_string()]);
        assert_eq!(fm["tags"], vec!["a".to_string(), "b".to_string(), "c d".to_string()]);
        assert_eq!(fm["status"], vec!["todo".to_string()]);
    }

    #[test]
    fn parses_block_list() {
        let src = "---\ntags:\n  - foo\n  - bar\nstatus: done\n---\n";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(fm["tags"], vec!["foo".to_string(), "bar".to_string()]);
        assert_eq!(fm["status"], vec!["done".to_string()]);
    }

    #[test]
    fn no_frontmatter() {
        assert!(parse_frontmatter("hello\nworld").is_none());
    }

    #[test]
    fn ignores_inline_comment() {
        let src = "---\nstatus: todo # 这是注释\n---\n";
        let fm = parse_frontmatter(src).unwrap();
        assert_eq!(fm["status"], vec!["todo".to_string()]);
    }
}
