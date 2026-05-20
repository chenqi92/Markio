// Git 同步后端。
//
// 使用本机 git CLI，避开 gitoxide 版本间不稳定的 status/push API。
// 所有命令都走非交互模式；PAT 只临时注入 HTTPS URL，不写入仓库配置。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub head: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileStatus>,
}

fn empty_status() -> GitStatus {
    GitStatus {
        head: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    }
}

fn has_git_metadata(path: &Path) -> bool {
    path.ancestors()
        .any(|ancestor| ancestor.join(".git").exists())
}

fn map_io(e: std::io::Error) -> String {
    format!("git: {e}")
}

fn ensure_git() -> Result<(), String> {
    let output = Command::new("git")
        .arg("--version")
        .output()
        .map_err(map_io)?;
    if output.status.success() {
        Ok(())
    } else {
        Err("git: 未找到可用的 git 命令".to_string())
    }
}

fn run_git(path: &Path, args: &[&str]) -> Result<String, String> {
    ensure_git()?;
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(map_io)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {args:?} 失败")
        } else {
            format!("git: {stderr}")
        })
    }
}

fn run_git_env(path: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, String> {
    ensure_git()?;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let output = cmd.output().map_err(map_io)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git {args:?} 失败")
        } else {
            format!("git: {stderr}")
        })
    }
}

fn redact_token(s: &str, token: Option<&str>) -> String {
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        s.replace(t, "***")
    } else {
        s.to_string()
    }
}

fn remote_host(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        if let Some(end) = rest.find('/') {
            return rest[..end].to_string();
        }
        return rest.to_string();
    }
    if let Some(rest) = url.strip_prefix("git@") {
        if let Some(end) = rest.find(':') {
            return rest[..end].to_string();
        }
    }
    url.to_string()
}

pub fn keychain_account_for_url(url: &str) -> String {
    format!("git:{}", remote_host(url))
}

fn inject_askpass_user(url: &str, pat: &str) -> String {
    if pat.is_empty() || url.contains('@') {
        return url.to_string();
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return format!("https://x-access-token@{rest}");
    }
    url.to_string()
}

pub fn default_remote_url(path: &Path) -> Result<String, String> {
    run_git(path, &["remote", "get-url", "origin"])
}

fn askpass_path() -> PathBuf {
    let ext = if cfg!(windows) { "cmd" } else { "sh" };
    let ts = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    std::env::temp_dir().join(format!(
        "markio-git-askpass-{}-{ts}.{ext}",
        std::process::id()
    ))
}

fn write_askpass(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let script = "@echo off\r\nsetlocal\r\nset PROMPT=%~1\r\necho %MARKIO_GIT_PAT%\r\n";
    #[cfg(not(windows))]
    let script = "#!/bin/sh\nprintf '%s\\n' \"$MARKIO_GIT_PAT\"\n";
    std::fs::write(path, script).map_err(|e| format!("创建 Git askpass 失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = std::fs::metadata(path)
            .map_err(|e| format!("读取 askpass 权限失败：{e}"))?
            .permissions();
        perm.set_mode(0o700);
        std::fs::set_permissions(path, perm).map_err(|e| format!("设置 askpass 权限失败：{e}"))?;
    }
    Ok(())
}

fn run_command_auth(
    mut cmd: Command,
    pat: Option<&str>,
    args_for_error: &str,
) -> Result<String, String> {
    let askpass = if pat.filter(|s| !s.is_empty()).is_some() {
        let path = askpass_path();
        write_askpass(&path)?;
        cmd.env("GIT_ASKPASS", &path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("MARKIO_GIT_PAT", pat.unwrap_or_default());
        Some(path)
    } else {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        None
    };
    let output = cmd.output().map_err(map_io);
    if let Some(path) = askpass {
        let _ = std::fs::remove_file(path);
    }
    let output = output?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = redact_token(String::from_utf8_lossy(&output.stderr).trim(), pat);
        Err(if stderr.is_empty() {
            format!("git {args_for_error} 失败")
        } else {
            format!("git: {stderr}")
        })
    }
}

fn run_git_auth(path: &Path, args: &[&str], pat: Option<&str>) -> Result<String, String> {
    ensure_git()?;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(path).args(args);
    run_command_auth(cmd, pat, &format!("{args:?}"))
}

pub fn init(path: &Path) -> Result<(), String> {
    ensure_git()?;
    if path.join(".git").exists() {
        return Err("仓库已经初始化".to_string());
    }
    std::fs::create_dir_all(path).map_err(|e| format!("创建目录失败：{e}"))?;
    let output = Command::new("git")
        .arg("init")
        .arg(path)
        .output()
        .map_err(map_io)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

pub fn clone(url: &str, dest: &Path, pat: Option<&str>) -> Result<(), String> {
    ensure_git()?;
    if dest.exists()
        && dest
            .read_dir()
            .map(|mut i| i.next().is_some())
            .unwrap_or(false)
    {
        return Err("目标目录已存在且非空".to_string());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let real_url = pat
        .filter(|s| !s.is_empty())
        .map(|token| inject_askpass_user(url, token))
        .unwrap_or_else(|| url.to_string());
    let mut cmd = Command::new("git");
    cmd.arg("clone").arg(real_url).arg(dest);
    run_command_auth(cmd, pat, "clone").map(|_| ())
}

fn optional_git(path: &Path, args: &[&str]) -> Option<String> {
    run_git(path, args).ok().filter(|s| !s.is_empty())
}

fn ahead_behind(path: &Path) -> (u32, u32) {
    let Ok(out) = run_git(
        path,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    ) else {
        return (0, 0);
    };
    let mut parts = out.split_whitespace();
    let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn parse_status_line(line: &str) -> Option<GitFileStatus> {
    if line.len() < 4 {
        return None;
    }
    let xy = &line[..2];
    let raw_path = line[3..].trim();
    let kind = if xy == "??" {
        "untracked"
    } else if xy.contains('D') {
        "deleted"
    } else if xy.contains('A') {
        "added"
    } else if xy.contains('R') {
        "renamed"
    } else {
        "modified"
    };
    Some(GitFileStatus {
        path: raw_path.to_string(),
        kind: kind.to_string(),
    })
}

pub fn status(path: &Path) -> Result<GitStatus, String> {
    // `git -C <non-repo> status` is surprisingly expensive on large synced
    // folders. The status bar polls this path, so short-circuit common note
    // vaults that are not Git repositories before spawning any git process.
    if !has_git_metadata(path) {
        return Ok(empty_status());
    }
    let head = optional_git(path, &["rev-parse", "--short=7", "HEAD"]);
    let branch = optional_git(path, &["branch", "--show-current"]);
    let upstream = optional_git(
        path,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    );
    let (ahead, behind) = ahead_behind(path);
    let porcelain = run_git(path, &["status", "--porcelain=v1"])?;
    let files = porcelain
        .lines()
        .filter_map(parse_status_line)
        .collect::<Vec<_>>();
    Ok(GitStatus {
        head,
        branch,
        upstream,
        ahead,
        behind,
        files,
    })
}

fn validate_rel_path(rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err("文件路径不能以分隔符开头".to_string());
    }
    if rel.contains('\0') || rel.contains('\n') || rel.contains('\r') {
        return Err("文件路径包含非法控制字符".to_string());
    }
    for seg in rel.split(['/', '\\']) {
        if seg == ".." {
            return Err("文件路径不能包含 ..".to_string());
        }
    }
    Ok(())
}

pub fn commit(
    path: &Path,
    message: &str,
    author_name: &str,
    author_email: &str,
    files: Option<&[String]>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message 不能为空".to_string());
    }
    match files {
        Some(list) if !list.is_empty() => {
            for f in list {
                validate_rel_path(f)?;
            }
            let mut args: Vec<&str> = vec!["add", "--"];
            args.extend(list.iter().map(|s| s.as_str()));
            run_git(path, &args)?;
        }
        _ => {
            run_git(path, &["add", "-A"])?;
        }
    }
    run_git_env(
        path,
        &["commit", "-m", message],
        &[
            ("GIT_AUTHOR_NAME", author_name),
            ("GIT_AUTHOR_EMAIL", author_email),
            ("GIT_COMMITTER_NAME", author_name),
            ("GIT_COMMITTER_EMAIL", author_email),
        ],
    )?;
    run_git(path, &["rev-parse", "--short=7", "HEAD"])
}

pub fn fetch(path: &Path, remote: &str, pat: Option<&str>) -> Result<(), String> {
    validate_remote_name(remote)?;
    run_git_auth(path, &["fetch", remote], pat)?;
    Ok(())
}

/// 解析 status --porcelain 输出的 UU/AA/DD 行，返回冲突文件列表。
fn unmerged_files(path: &Path) -> Vec<String> {
    let Ok(out) = run_git(path, &["status", "--porcelain=v1"]) else {
        return Vec::new();
    };
    out.lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let xy = &line[..2];
            let is_unmerged = matches!(xy, "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU");
            if is_unmerged {
                Some(line[3..].trim().to_string())
            } else {
                None
            }
        })
        .collect()
}

fn encode_conflict(files: &[String]) -> String {
    format!("CONFLICT:{}", files.join("\n"))
}

pub fn pull(
    path: &Path,
    remote: &str,
    branch: Option<&str>,
    pat: Option<&str>,
    rebase: bool,
) -> Result<(u32, u32), String> {
    validate_remote_name(remote)?;
    if let Some(b) = branch {
        validate_ref_name(b)?;
    }
    let mut args: Vec<&str> = vec!["pull"];
    if rebase {
        args.push("--rebase");
    } else {
        args.push("--no-rebase");
    }
    args.push(remote);
    if let Some(b) = branch {
        args.push(b);
    }
    match run_git_auth(path, &args, pat) {
        Ok(_) => Ok(ahead_behind(path)),
        Err(e) => {
            let unmerged = unmerged_files(path);
            if !unmerged.is_empty() {
                Err(encode_conflict(&unmerged))
            } else {
                Err(e)
            }
        }
    }
}

pub fn push(
    path: &Path,
    remote: &str,
    branch: Option<&str>,
    pat: Option<&str>,
    set_upstream: bool,
) -> Result<(), String> {
    validate_remote_name(remote)?;
    if let Some(b) = branch {
        validate_ref_name(b)?;
    }
    let mut args: Vec<&str> = vec!["push"];
    if set_upstream {
        args.push("-u");
    }
    args.push(remote);
    if let Some(b) = branch {
        args.push(b);
    } else {
        args.push("HEAD");
    }
    run_git_auth(path, &args, pat)?;
    Ok(())
}

fn validate_remote_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("remote 名称不能为空".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("remote 名称只能包含字母、数字、- _ .".to_string());
    }
    Ok(())
}

fn validate_ref_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("分支名不能为空".to_string());
    }
    if name.starts_with('-') {
        return Err("分支名不能以 - 开头".to_string());
    }
    for bad in [
        ' ', '\t', '\n', '\r', '~', '^', ':', '?', '*', '[', '\\', '\0',
    ] {
        if name.contains(bad) {
            return Err(format!("分支名包含非法字符：{bad:?}"));
        }
    }
    if name.contains("..") {
        return Err("分支名不能包含 ..".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: Option<String>,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub fn list_branches(path: &Path) -> Result<GitBranches, String> {
    let current = optional_git(path, &["branch", "--show-current"]);
    let local_raw = run_git(path, &["branch", "--format=%(refname:short)"]).unwrap_or_default();
    let local = local_raw
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let remote_raw =
        run_git(path, &["branch", "-r", "--format=%(refname:short)"]).unwrap_or_default();
    let remote = remote_raw
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.ends_with("/HEAD"))
        .collect();
    Ok(GitBranches {
        current,
        local,
        remote,
    })
}

pub fn checkout(path: &Path, branch: &str, create: bool) -> Result<(), String> {
    validate_ref_name(branch)?;
    if create {
        run_git(path, &["checkout", "-b", branch])?;
    } else {
        run_git(path, &["checkout", branch])?;
    }
    Ok(())
}

/// 冲突恢复：strategy = "ours" / "theirs" 选边，"abort" 整个 merge 终止。
pub fn resolve_conflict(path: &Path, strategy: &str, files: &[String]) -> Result<(), String> {
    match strategy {
        "abort" => {
            run_git(path, &["merge", "--abort"])
                .or_else(|_| run_git(path, &["rebase", "--abort"]))?;
            Ok(())
        }
        "ours" | "theirs" => {
            if files.is_empty() {
                return Err("resolve_conflict 需要文件列表".to_string());
            }
            let flag = if strategy == "ours" {
                "--ours"
            } else {
                "--theirs"
            };
            for f in files {
                validate_rel_path(f)?;
                run_git(path, &["checkout", flag, "--", f])?;
                run_git(path, &["add", "--", f])?;
            }
            Ok(())
        }
        _ => Err(format!("未知冲突策略：{strategy}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_kinds() {
        let cases = vec![
            ("?? new.md", "untracked", "new.md"),
            (" M docs/x.md", "modified", "docs/x.md"),
            ("A  added.md", "added", "added.md"),
            (" D removed.md", "deleted", "removed.md"),
            ("R  old.md -> new.md", "renamed", "old.md -> new.md"),
        ];
        for (line, want_kind, want_path) in cases {
            let g = parse_status_line(line).expect("expected Some");
            assert_eq!(g.kind, want_kind, "kind mismatch for {line:?}");
            assert_eq!(g.path, want_path, "path mismatch for {line:?}");
        }
    }

    #[test]
    fn rejects_too_short() {
        assert!(parse_status_line("").is_none());
        assert!(parse_status_line("?").is_none());
    }

    #[test]
    fn keychain_account_strips_scheme_and_path() {
        assert_eq!(
            keychain_account_for_url("https://github.com/foo/bar.git"),
            "git:github.com",
        );
        assert_eq!(
            keychain_account_for_url("git@gitlab.com:foo/bar.git"),
            "git:gitlab.com",
        );
    }

    #[test]
    fn validate_rel_path_rejects_traversal() {
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("/abs").is_err());
        assert!(validate_rel_path("a/../b").is_err());
        assert!(validate_rel_path("ok/sub/file.md").is_ok());
    }

    #[test]
    fn validate_ref_name_rejects_unsafe() {
        assert!(validate_ref_name("").is_err());
        assert!(validate_ref_name("-foo").is_err());
        assert!(validate_ref_name("foo bar").is_err());
        assert!(validate_ref_name("foo..bar").is_err());
        assert!(validate_ref_name("foo~1").is_err());
        assert!(validate_ref_name("main").is_ok());
        assert!(validate_ref_name("feature/x-1").is_ok());
    }

    #[test]
    fn validate_remote_name_strict() {
        assert!(validate_remote_name("origin").is_ok());
        assert!(validate_remote_name("my-remote.1").is_ok());
        assert!(validate_remote_name("").is_err());
        assert!(validate_remote_name("bad name").is_err());
        assert!(validate_remote_name("--upload-pack=cmd").is_err());
    }

    #[test]
    fn encode_conflict_format() {
        assert_eq!(
            encode_conflict(&["a.md".into(), "b/c.md".into()]),
            "CONFLICT:a.md\nb/c.md"
        );
    }

    #[test]
    fn injects_askpass_user_only_into_clean_https() {
        assert_eq!(
            inject_askpass_user("https://github.com/x/y.git", "ghp_abc"),
            "https://x-access-token@github.com/x/y.git",
        );
        // 已有凭据不重复加
        assert_eq!(
            inject_askpass_user("https://user@github.com/x/y.git", "ghp_abc"),
            "https://user@github.com/x/y.git",
        );
        // SSH URL 不动
        assert_eq!(
            inject_askpass_user("git@github.com:x/y.git", "ghp_abc"),
            "git@github.com:x/y.git",
        );
        // 空 PAT 不动
        assert_eq!(
            inject_askpass_user("https://github.com/x/y.git", ""),
            "https://github.com/x/y.git",
        );
    }

    #[test]
    fn status_short_circuits_non_git_dirs() {
        let unique = format!(
            "markio-non-git-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).unwrap();

        let status = status(&dir).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
        assert!(status.branch.is_none());
        assert_eq!(status.files.len(), 0);
    }
}
