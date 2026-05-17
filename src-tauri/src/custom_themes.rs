// 用户自定义 CSS 主题：导入 / 列出 / 删除 / 读取。
//
// 主题文件放在 ~/<config>/markio/themes/<id>.css，id 由文件名 stem 经 sanitize 后得到。
// CSS 体积上限 256 KB，避免被恶意大文件灌坏 UI。

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const MAX_THEME_BYTES: u64 = 256 * 1024;

fn themes_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Application Support/markio/themes");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(base) = std::env::var_os("APPDATA") {
            return PathBuf::from(base).join("markio").join("themes");
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".config/markio/themes");
        }
    }
    std::env::temp_dir().join("markio-themes")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
}

fn sanitize_id(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if c == ' ' || c == '.' {
            out.push('-');
        }
        // 其它字符直接丢
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    Some(trimmed)
}

pub fn ensure_dir() -> Result<PathBuf, String> {
    let dir = themes_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建主题目录失败：{e}"))?;
    Ok(dir)
}

pub fn list() -> Result<Vec<CustomTheme>, String> {
    let dir = ensure_dir()?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("css") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Some(id) = sanitize_id(stem) else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > MAX_THEME_BYTES {
            continue;
        }
        out.push(CustomTheme {
            id: id.clone(),
            name: stem.to_string(),
            path: path.to_string_lossy().to_string(),
            size,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub fn import(source_path: &str) -> Result<CustomTheme, String> {
    let src = Path::new(source_path);
    if !src.is_file() {
        return Err("主题源文件不存在".to_string());
    }
    let meta = std::fs::metadata(src).map_err(|e| format!("读取主题元数据失败：{e}"))?;
    if meta.len() > MAX_THEME_BYTES {
        return Err(format!("主题文件超过 {} KB", MAX_THEME_BYTES / 1024));
    }
    if src.extension().and_then(|s| s.to_str()) != Some("css") {
        return Err("只支持 .css 文件".to_string());
    }
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "主题文件名无效".to_string())?;
    let id = sanitize_id(stem).ok_or_else(|| "主题文件名无效（清洗后为空）".to_string())?;
    let dir = ensure_dir()?;
    let dest = dir.join(format!("{id}.css"));
    std::fs::copy(src, &dest).map_err(|e| format!("拷贝主题失败：{e}"))?;
    Ok(CustomTheme {
        id,
        name: stem.to_string(),
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

pub fn read(id: &str) -> Result<String, String> {
    let id_clean = sanitize_id(id).ok_or_else(|| "主题 id 无效".to_string())?;
    let dir = ensure_dir()?;
    let path = dir.join(format!("{id_clean}.css"));
    let meta = std::fs::metadata(&path).map_err(|e| format!("主题不存在：{e}"))?;
    if meta.len() > MAX_THEME_BYTES {
        return Err("主题文件过大".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取主题失败：{e}"))
}

pub fn delete(id: &str) -> Result<(), String> {
    let id_clean = sanitize_id(id).ok_or_else(|| "主题 id 无效".to_string())?;
    let dir = ensure_dir()?;
    let path = dir.join(format!("{id_clean}.css"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除主题失败：{e}"))?;
    }
    Ok(())
}

pub fn dir_path() -> Result<String, String> {
    let dir = ensure_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_id_strips_unsafe_chars() {
        assert_eq!(sanitize_id("My Theme!").unwrap(), "My-Theme");
        assert_eq!(sanitize_id("a/b\\c").unwrap(), "abc");
        assert_eq!(sanitize_id("ok-name_1").unwrap(), "ok-name_1");
        assert!(sanitize_id("").is_none());
        assert!(sanitize_id("中文").is_none()); // 全被丢，结果为空
    }

    #[test]
    fn sanitize_id_caps_length() {
        let long = "a".repeat(65);
        assert!(sanitize_id(&long).is_none());
        let ok = "a".repeat(64);
        assert!(sanitize_id(&ok).is_some());
    }
}
