//! See parent module `fs_ops` for orientation. Split out from the original
//! 1810-line `fs_ops.rs` to keep each concern in a focused file.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::ignore::IgnoreRules;
use super::walker_io::{is_hidden, is_markdown, ignored_by_rules, modified_ms, atomic_write, MAX_DEPTH};
use super::tokens::extract_tokens_into;

// ─── 持久化 vault index ─────────────────────────────────────────────
//
// 比 `index_tokens` 多带文件路径 / mtime / 大小，并把每个文件抽出的
// tags / mentions 一并存下来。下次启动时按 mtime diff 只重读改动过的
// 文件，未改动的复用旧记录。
//
// 落盘到 `<workspace>/.markio/index.json`，CommandPalette / Autocomplete
// 直接从这份内存中的 index 读"全 vault 文件列表"，不再依赖懒加载的 UI 树。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFile {
    pub path: String,
    pub name: String,
    pub stem: String,
    pub mtime: i64,
    pub size: u64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub mentions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndex {
    pub files: Vec<VaultFile>,
    pub tags: Vec<String>,
    pub mentions: Vec<String>,
    pub scanned_at: i64,
}

const VAULT_INDEX_SCHEMA: u32 = 1;
const VAULT_INDEX_MAX_FILES: usize = 50_000;
const VAULT_INDEX_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultIndexEnvelope {
    schema: u32,
    #[serde(flatten)]
    index: VaultIndex,
}

fn vault_index_path(workspace: &str) -> PathBuf {
    PathBuf::from(workspace).join(".markio").join("index.json")
}

pub fn vault_index_load(workspace: &str) -> Option<VaultIndex> {
    let p = vault_index_path(workspace);
    if !p.exists() {
        return None;
    }
    let text = fs::read_to_string(&p).ok()?;
    let env: VaultIndexEnvelope = serde_json::from_str(&text).ok()?;
    if env.schema != VAULT_INDEX_SCHEMA {
        return None;
    }
    Some(env.index)
}

pub fn vault_index_save(workspace: &str, index: &VaultIndex) -> Result<(), String> {
    let p = vault_index_path(workspace);
    let parent = p.parent().ok_or_else(|| "无效 index 路径".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let env = VaultIndexEnvelope {
        schema: VAULT_INDEX_SCHEMA,
        index: index.clone(),
    };
    let body = serde_json::to_string(&env).map_err(|e| e.to_string())?;
    atomic_write(&p, &body)
}

/// 全 vault 扫描 + 抽 tag / mention，可选地用 `prev` 的 mtime 做 diff
/// 复用未改动文件的 token，避免重新读盘。
pub fn build_vault_index(workspace: &str, prev: Option<&VaultIndex>) -> VaultIndex {
    use std::collections::BTreeSet;

    let prev_by_path: HashMap<String, &VaultFile> = prev
        .map(|p| p.files.iter().map(|f| (f.path.clone(), f)).collect())
        .unwrap_or_default();

    let mut files: Vec<VaultFile> = Vec::new();
    let mut tags: BTreeSet<String> = BTreeSet::new();
    let mut mentions: BTreeSet<String> = BTreeSet::new();

    let root = Path::new(workspace);
    let ignore = IgnoreRules::load(root);
    struct VaultIndexVisit<'a, 'p> {
        root: &'a Path,
        prev_by_path: &'a HashMap<String, &'p VaultFile>,
        ignore: &'a IgnoreRules,
    }
    impl VaultIndexVisit<'_, '_> {
        fn visit(
            &self,
            dir: &Path,
            depth: usize,
            files: &mut Vec<VaultFile>,
            tags: &mut std::collections::BTreeSet<String>,
            mentions: &mut std::collections::BTreeSet<String>,
        ) {
            if depth > MAX_DEPTH || files.len() >= VAULT_INDEX_MAX_FILES {
                return;
            }
            let entries = match fs::read_dir(dir) {
                Ok(e) => e,
                Err(e) => {
                    // 桌面端常见：用户把 ~/Downloads 加成仓库后子目录没有读权限。
                    // 之前静默跳过会让人误以为"索引建好了"——这里至少留 trace。
                    eprintln!("[vault-index] 跳过目录 {}：{e}", dir.display());
                    return;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        eprintln!("[vault-index] 跳过 entry @ {}：{e}", dir.display());
                        continue;
                    }
                };
                if files.len() >= VAULT_INDEX_MAX_FILES {
                    return;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if is_hidden(&name) {
                    continue;
                }
                let path = entry.path();
                let ft = match entry.file_type() {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("[vault-index] file_type 失败 {}：{e}", path.display());
                        continue;
                    }
                };
                if ft.is_symlink() {
                    continue;
                }
                if ignored_by_rules(self.root, &path, ft.is_dir(), self.ignore) {
                    continue;
                }
                if ft.is_dir() {
                    self.visit(&path, depth + 1, files, tags, mentions);
                } else if ft.is_file() && is_markdown(&name) {
                    let stem = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let path_str = path.to_string_lossy().to_string();
                    let meta = entry.metadata().ok();
                    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                    let mtime = modified_ms(&path);

                    let (file_tags, file_mentions) =
                        if let Some(old) = self.prev_by_path.get(&path_str) {
                            if old.mtime == mtime && old.size == size {
                                (old.tags.clone(), old.mentions.clone())
                            } else {
                                extract_file_tokens(&path, size)
                            }
                        } else {
                            extract_file_tokens(&path, size)
                        };

                    for t in &file_tags {
                        tags.insert(t.clone());
                    }
                    for m in &file_mentions {
                        mentions.insert(m.clone());
                    }

                    files.push(VaultFile {
                        path: path_str,
                        name,
                        stem,
                        mtime,
                        size,
                        tags: file_tags,
                        mentions: file_mentions,
                    });
                }
            }
        }
    }
    VaultIndexVisit {
        root,
        prev_by_path: &prev_by_path,
        ignore: &ignore,
    }
    .visit(root, 0, &mut files, &mut tags, &mut mentions);

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    VaultIndex {
        files,
        tags: tags.into_iter().collect(),
        mentions: mentions.into_iter().collect(),
        scanned_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn extract_file_tokens(path: &Path, size: u64) -> (Vec<String>, Vec<String>) {
    use std::collections::BTreeSet;
    if size > VAULT_INDEX_MAX_FILE_BYTES {
        return (Vec::new(), Vec::new());
    }
    let Ok(content) = fs::read_to_string(path) else {
        return (Vec::new(), Vec::new());
    };
    let mut tags: BTreeSet<String> = BTreeSet::new();
    let mut mentions: BTreeSet<String> = BTreeSet::new();
    extract_tokens_into(&content, &mut tags, &mut mentions);
    (tags.into_iter().collect(), mentions.into_iter().collect())
}

