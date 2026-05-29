//! Git 同步：init / clone / status / fetch / commit / pull / push /
//! list_branches / checkout / resolve_conflict / set_pat / has_pat。
//!
//! PAT 走 OS 钥匙串，account 由 URL 推导（git_ops::keychain_account_for_url）。
//! 实际 git 操作在 git_ops 模块（git2 crate 包装），命令侧只做路径校验 + 阻塞调度。

use crate::{git_ops, secrets, validate_path, AppState};

fn resolve_git_pat(url: &str, explicit: Option<String>) -> Option<String> {
    if let Some(t) = explicit.filter(|s| !s.is_empty()) {
        return Some(t);
    }
    let account = git_ops::keychain_account_for_url(url);
    secrets::get(&account)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

fn git_remote_url(path: &std::path::Path) -> Option<String> {
    git_ops::default_remote_url(path).ok()
}

#[tauri::command]
pub async fn git_init(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = validate_path(&state, &path)?;
    tauri::async_runtime::spawn_blocking(move || git_ops::init(&canon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_clone(
    state: tauri::State<'_, AppState>,
    url: String,
    dest: String,
    pat: Option<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &dest)?;
    let pat = resolve_git_pat(&url, pat);
    let url2 = url.clone();
    tauri::async_runtime::spawn_blocking(move || git_ops::clone(&url2, &canon, pat.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_status(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<git_ops::GitStatus, String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || git_ops::status(&canon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fetch(
    state: tauri::State<'_, AppState>,
    workspace: String,
    remote: Option<String>,
    pat: Option<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    let url = git_remote_url(&canon).unwrap_or_default();
    let pat = if url.is_empty() {
        pat.filter(|s| !s.is_empty())
    } else {
        resolve_git_pat(&url, pat)
    };
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    tauri::async_runtime::spawn_blocking(move || git_ops::fetch(&canon, &remote, pat.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(
    state: tauri::State<'_, AppState>,
    workspace: String,
    message: String,
    author_name: String,
    author_email: String,
    files: Option<Vec<String>>,
) -> Result<String, String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::commit(
            &canon,
            &message,
            &author_name,
            &author_email,
            files.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(
    state: tauri::State<'_, AppState>,
    workspace: String,
    remote: Option<String>,
    branch: Option<String>,
    rebase: Option<bool>,
    pat: Option<String>,
) -> Result<(u32, u32), String> {
    let canon = validate_path(&state, &workspace)?;
    let url = git_remote_url(&canon).unwrap_or_default();
    let pat = if url.is_empty() {
        pat.filter(|s| !s.is_empty())
    } else {
        resolve_git_pat(&url, pat)
    };
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    let rebase = rebase.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::pull(&canon, &remote, branch.as_deref(), pat.as_deref(), rebase)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(
    state: tauri::State<'_, AppState>,
    workspace: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: Option<bool>,
    pat: Option<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    let url = git_remote_url(&canon).unwrap_or_default();
    let pat = if url.is_empty() {
        pat.filter(|s| !s.is_empty())
    } else {
        resolve_git_pat(&url, pat)
    };
    let remote = remote.unwrap_or_else(|| "origin".to_string());
    let set_upstream = set_upstream.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::push(
            &canon,
            &remote,
            branch.as_deref(),
            pat.as_deref(),
            set_upstream,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_list_branches(
    state: tauri::State<'_, AppState>,
    workspace: String,
) -> Result<git_ops::GitBranches, String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || git_ops::list_branches(&canon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_checkout(
    state: tauri::State<'_, AppState>,
    workspace: String,
    branch: String,
    create: Option<bool>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    let create = create.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || git_ops::checkout(&canon, &branch, create))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_resolve_conflict(
    state: tauri::State<'_, AppState>,
    workspace: String,
    strategy: String,
    files: Vec<String>,
) -> Result<(), String> {
    let canon = validate_path(&state, &workspace)?;
    tauri::async_runtime::spawn_blocking(move || {
        git_ops::resolve_conflict(&canon, &strategy, &files)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把 PAT 存到 OS 钥匙串。account 由 URL 推导（`git:<host>`），前端无需关心。
#[tauri::command]
pub fn git_set_pat(url: String, pat: String) -> Result<(), String> {
    let account = git_ops::keychain_account_for_url(&url);
    if pat.is_empty() {
        secrets::delete(&account)
    } else {
        secrets::set(&account, &pat)
    }
}

#[tauri::command]
pub fn git_has_pat(url: String) -> Result<bool, String> {
    let account = git_ops::keychain_account_for_url(&url);
    Ok(secrets::has(&account))
}
