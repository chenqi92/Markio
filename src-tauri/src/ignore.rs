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
        self.patterns.iter().any(|p| {
            if p.directory_only && !is_dir && !path_has_dir_component(&rel_norm, &components, p) {
                return false;
            }
            matches_pattern(p, &rel_norm, &components)
        })
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
    if raw.is_empty() || raw.starts_with('#') || raw.starts_with('!') {
        return None;
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

fn glob_match(pattern: &str, text: &str) -> bool {
    let p = pattern.as_bytes();
    let t = text.as_bytes();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_ti = 0usize;

    while ti < t.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            star_ti = ti;
            pi += 1;
        } else if let Some(si) = star {
            pi = si + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
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
}
