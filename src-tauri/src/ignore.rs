use std::fs;
use std::path::{Component, Path};

const MAX_MARKIOIGNORE_BYTES: u64 = 64 * 1024;

const DEFAULT_IGNORED_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".markio",
    ".obsidian",
    ".idea",
    ".vscode",
    ".vs",
    "node_modules",
    "bower_components",
    "vendor",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".vite",
    ".cache",
    ".parcel-cache",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".gradle",
    ".venv",
    "venv",
    "env",
    "derivedata",
    "pods",
    ".bundle",
    ".terraform",
];

const CODE_PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "settings.gradle",
    "gradlew",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "composer.json",
    "Gemfile",
    "mix.exs",
];

#[derive(Debug, Clone)]
struct IgnorePattern {
    pattern: String,
    directory_only: bool,
    anchored: bool,
    has_slash: bool,
    /// `!` 前缀的反选规则：命中时把路径重新纳入（取消忽略）。
    negated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct IgnoreRules {
    patterns: Vec<IgnorePattern>,
}

impl IgnoreRules {
    pub fn load(workspace: &Path) -> Self {
        let path = workspace.join(".markioignore");
        let Ok(meta) = fs::metadata(&path) else {
            return Self::default();
        };
        if !meta.is_file() || meta.len() > MAX_MARKIOIGNORE_BYTES {
            return Self::default();
        }
        let Ok(content) = fs::read_to_string(path) else {
            return Self::default();
        };
        Self::from_content(&content)
    }

    pub fn is_ignored(&self, rel: &Path, is_dir: bool) -> bool {
        if is_default_ignored_path(rel) {
            return true;
        }

        let rel_norm = normalize_rel_path(rel);
        if rel_norm.is_empty() {
            return false;
        }

        let components = rel_components_lower(rel);
        // gitignore 语义：按顺序求值，最后一条命中的规则决定结果，
        // `!` 反选可取消前面 .markioignore 规则的忽略（但不能复活默认忽略目录）。
        let mut ignored = false;
        for p in &self.patterns {
            if p.directory_only && !is_dir && !path_has_dir_component(&rel_norm, &components, p) {
                continue;
            }
            if matches_pattern(p, &rel_norm, &components) {
                ignored = !p.negated;
            }
        }
        ignored
    }

    fn from_content(content: &str) -> Self {
        let patterns = content.lines().filter_map(parse_line).collect::<Vec<_>>();
        Self { patterns }
    }
}

pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

pub fn is_default_ignored_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    is_hidden_name(&lower) || DEFAULT_IGNORED_NAMES.iter().any(|n| lower == *n)
}

pub fn is_default_ignored_path(rel: &Path) -> bool {
    rel.components().any(|comp| match comp {
        Component::Normal(os) => is_default_ignored_name(&os.to_string_lossy()),
        _ => false,
    })
}

pub fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}

pub fn is_text_note_path(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown" | "mdown" | "mkd" | "txt"
    )
}

pub fn is_nested_code_project_dir(workspace: &Path, dir: &Path) -> bool {
    if dir == workspace {
        return false;
    }
    if !dir.starts_with(workspace) || !dir.is_dir() {
        return false;
    }
    CODE_PROJECT_MARKERS
        .iter()
        .any(|marker| dir.join(marker).exists())
}

pub fn is_under_nested_code_project(workspace: &Path, path: &Path) -> bool {
    for ancestor in path.ancestors() {
        if ancestor == workspace {
            return false;
        }
        if is_nested_code_project_dir(workspace, ancestor) {
            return true;
        }
    }
    false
}

fn parse_line(line: &str) -> Option<IgnorePattern> {
    let mut raw = line.trim();
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    let negated = raw.starts_with('!');
    if negated {
        raw = raw[1..].trim();
    }
    raw = raw.trim_matches('"').trim_matches('\'').trim();
    if raw.is_empty() {
        return None;
    }
    let anchored = raw.starts_with('/');
    let raw = raw.trim_start_matches('/');
    let directory_only = raw.ends_with('/');
    let raw = raw.trim_end_matches('/');
    if raw.is_empty() {
        return None;
    }
    let pattern = raw.replace('\\', "/").to_ascii_lowercase();
    let has_slash = pattern.contains('/');
    Some(IgnorePattern {
        pattern,
        directory_only,
        anchored,
        has_slash,
        negated,
    })
}

fn normalize_rel_path(path: &Path) -> String {
    path.components()
        .filter_map(|comp| match comp {
            Component::Normal(os) => Some(os.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn rel_components_lower(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|comp| match comp {
            Component::Normal(os) => Some(os.to_string_lossy().to_ascii_lowercase()),
            _ => None,
        })
        .collect()
}

fn matches_pattern(p: &IgnorePattern, rel: &str, components: &[String]) -> bool {
    if p.has_slash || p.anchored {
        if p.anchored {
            glob_match(&p.pattern, rel)
                || rel
                    .strip_prefix(&p.pattern)
                    .is_some_and(|rest| rest.starts_with('/'))
        } else {
            glob_match(&p.pattern, rel)
                || rel.ends_with(&format!("/{}", p.pattern))
                || rel.contains(&format!("/{}/", p.pattern))
        }
    } else {
        components.iter().any(|c| glob_match(&p.pattern, c))
    }
}

fn path_has_dir_component(rel: &str, components: &[String], p: &IgnorePattern) -> bool {
    if p.has_slash || p.anchored {
        rel == p.pattern
            || rel
                .strip_prefix(&p.pattern)
                .is_some_and(|rest| rest.starts_with('/'))
            || rel.contains(&format!("/{}/", p.pattern))
    } else {
        components.iter().any(|c| glob_match(&p.pattern, c))
    }
}

/// gitignore 风格 glob：单个 `*` / `?` **不跨越 `/`**（按段匹配），`**` 才跨目录。
/// 旧实现里 `*` 会吞掉 `/`，导致 `tmp/*.md` 误伤 `tmp/sub/deep/draft.md`、`docs/*`
/// 吞掉整棵子树，把本应可见的笔记从树/搜索/索引里静默隐藏。
/// 递归回溯，正确处理多个 `*` 与 `**`（短模式下足够快）。
fn glob_match(pattern: &str, text: &str) -> bool {
    glob_rec(pattern.as_bytes(), text.as_bytes())
}

fn glob_rec(p: &[u8], t: &[u8]) -> bool {
    let mut pi = 0;
    let mut ti = 0;
    while pi < p.len() {
        match p[pi] {
            b'*' => {
                let dbl = pi + 1 < p.len() && p[pi + 1] == b'*';
                let after = if dbl { &p[pi + 2..] } else { &p[pi + 1..] };
                // `a/**/b` 要能匹配 `a/b`（零个中间目录）：把 `**/` 整体折叠为空，
                // 即跳过 `**` 紧跟的 '/' 再尝试。
                if dbl && after.first() == Some(&b'/') && glob_rec(&after[1..], &t[ti..]) {
                    return true;
                }
                // 零宽匹配
                if glob_rec(after, &t[ti..]) {
                    return true;
                }
                let mut k = ti;
                while k < t.len() {
                    // 单星不跨 '/'
                    if !dbl && t[k] == b'/' {
                        break;
                    }
                    k += 1;
                    if glob_rec(after, &t[k..]) {
                        return true;
                    }
                }
                return false;
            }
            b'?' => {
                if ti >= t.len() || t[ti] == b'/' {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            c => {
                if ti >= t.len() || t[ti] != c {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == t.len()
}

#[cfg(test)]
mod tests {
    use super::{is_default_ignored_path, IgnoreRules};
    use std::path::Path;

    #[test]
    fn default_ignores_heavy_dependency_dirs() {
        assert!(is_default_ignored_path(Path::new(
            "project/node_modules/pkg"
        )));
        assert!(is_default_ignored_path(Path::new("target/debug/app")));
        assert!(is_default_ignored_path(Path::new(".git/HEAD")));
        assert!(!is_default_ignored_path(Path::new("notes/today.md")));
    }

    #[test]
    fn nested_code_project_detection_skips_children_not_workspace_root() {
        let root = std::env::temp_dir().join(format!(
            "markio-ignore-root-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let project = root.join("vendor-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("package.json"), "{}").unwrap();

        assert!(!super::is_nested_code_project_dir(&root, &root));
        assert!(super::is_nested_code_project_dir(&root, &project));
        assert!(super::is_under_nested_code_project(
            &root,
            &project.join("README.md")
        ));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn markioignore_matches_names_dirs_paths_and_globs() {
        let rules = IgnoreRules::from_content(
            r#"
            FastBee-master/
            tmp/*.md
            *.log
            /archive
            "#,
        );

        assert!(rules.is_ignored(Path::new("FastBee-master/readme.md"), false));
        assert!(rules.is_ignored(Path::new("tmp/draft.md"), false));
        assert!(rules.is_ignored(Path::new("logs/app.log"), false));
        assert!(rules.is_ignored(Path::new("archive/old.md"), false));
        assert!(!rules.is_ignored(Path::new("notes/app.md"), false));
    }

    #[test]
    fn single_star_does_not_cross_slash() {
        let rules = IgnoreRules::from_content("tmp/*.md\ndocs/*\n");
        // 直接子项命中
        assert!(rules.is_ignored(Path::new("tmp/draft.md"), false));
        assert!(rules.is_ignored(Path::new("docs/intro.md"), false));
        // 单星不跨 '/'：更深的嵌套不应被吞掉
        assert!(!rules.is_ignored(Path::new("tmp/sub/deep/draft.md"), false));
        assert!(!rules.is_ignored(Path::new("docs/sub/intro.md"), false));
    }

    #[test]
    fn double_star_crosses_directories() {
        let rules = IgnoreRules::from_content("tmp/**/*.md\n");
        assert!(rules.is_ignored(Path::new("tmp/sub/deep/draft.md"), false));
        assert!(rules.is_ignored(Path::new("tmp/draft.md"), false));
    }

    #[test]
    fn negation_reincludes() {
        // 用非默认忽略名（default 列表含 build/dist/target 等会短路）
        let rules = IgnoreRules::from_content("scratch/\n!scratch/keep.md\n");
        assert!(rules.is_ignored(Path::new("scratch/out.md"), false));
        assert!(!rules.is_ignored(Path::new("scratch/keep.md"), false));
    }
}
