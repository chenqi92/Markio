//! OneDrive OAuth + Microsoft Graph 文件 API：authorize / status / signout / list / upload /
//! download / delete / create_folder。
//!
//! tokens / client_id 存钥匙串；OAuth 走 PKCE + loopback redirect。client_id 传入为空时
//! 回退到编译期内置 client_id（builtin_credentials）。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    onedrive_ops, oauth, secrets, validate_body_size, validate_remote_rel_path, MAX_SYNC_BODY_BYTES,
};

const ONEDRIVE_TOKENS_ACCOUNT: &str = "onedrive:tokens";
const ONEDRIVE_CLIENT_ACCOUNT: &str = "onedrive:client_id";

fn load_tokens() -> Result<onedrive_ops::OneDriveTokens, String> {
    let raw =
        secrets::get(ONEDRIVE_TOKENS_ACCOUNT)?.ok_or_else(|| "尚未授权 OneDrive".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("OneDrive token 解析失败：{e}"))
}

fn save_tokens(tokens: &onedrive_ops::OneDriveTokens) -> Result<(), String> {
    let s = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    secrets::set(ONEDRIVE_TOKENS_ACCOUNT, &s)
}

async fn session() -> Result<onedrive_ops::OneDriveTokens, String> {
    let mut tokens = load_tokens()?;
    let client_id = secrets::get(ONEDRIVE_CLIENT_ACCOUNT)?
        .ok_or_else(|| "OneDrive client_id 丢失".to_string())?;
    if onedrive_ops::ensure_fresh(&mut tokens, &client_id).await? {
        save_tokens(&tokens)?;
    }
    Ok(tokens)
}

/// 归一化为 drive 根下的相对路径（无前导斜杠）。allow_root=true 时允许空串=根。
fn normalize_path(path: &str, allow_root: bool) -> Result<String, String> {
    let trimmed = path.trim().trim_start_matches('/');
    validate_remote_rel_path(trimmed, allow_root)?;
    Ok(trimmed.to_string())
}

#[tauri::command]
pub async fn onedrive_authorize(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<onedrive_ops::OneDriveStatus, String> {
    use tauri_plugin_opener::OpenerExt as _;
    let client_id = crate::builtin_credentials::resolve_client_id("onedrive", &client_id)?;
    let pkce = oauth::PkcePair::new()?;
    let state = oauth::random_state()?;
    let listener = oauth::LoopbackListener::bind().await?;
    let redirect = listener.redirect_uri();
    let url = onedrive_ops::build_authorize_url(&client_id, &redirect, &pkce.challenge, &state);
    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    let code = listener
        .wait_for_code(std::time::Duration::from_secs(300), Some(&state))
        .await?;
    let tokens = onedrive_ops::exchange_code(&client_id, &code, &pkce.verifier, &redirect).await?;
    save_tokens(&tokens)?;
    secrets::set(ONEDRIVE_CLIENT_ACCOUNT, &client_id)?;
    Ok(onedrive_ops::OneDriveStatus {
        connected: true,
        display: tokens.display,
        expires_in_secs: (tokens.expires_at as i64)
            - (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)),
    })
}

#[tauri::command]
pub fn onedrive_status() -> Result<onedrive_ops::OneDriveStatus, String> {
    match load_tokens() {
        Ok(t) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Ok(onedrive_ops::OneDriveStatus {
                connected: true,
                display: t.display,
                expires_in_secs: t.expires_at as i64 - now,
            })
        }
        Err(_) => Ok(onedrive_ops::OneDriveStatus {
            connected: false,
            display: String::new(),
            expires_in_secs: 0,
        }),
    }
}

#[tauri::command]
pub fn onedrive_signout() -> Result<(), String> {
    let a = secrets::delete(ONEDRIVE_TOKENS_ACCOUNT);
    let b = secrets::delete(ONEDRIVE_CLIENT_ACCOUNT);
    a.and(b)
}

#[tauri::command]
pub async fn onedrive_list(path: String) -> Result<onedrive_ops::OneDriveList, String> {
    let path = normalize_path(&path, true)?;
    let tokens = session().await?;
    onedrive_ops::list(&tokens, &path).await
}

#[tauri::command]
pub async fn onedrive_upload(path: String, body_base64: String) -> Result<(), String> {
    let path = normalize_path(&path, false)?;
    validate_body_size("OneDrive 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    let tokens = session().await?;
    onedrive_ops::upload(&tokens, &path, bytes).await
}

#[tauri::command]
pub async fn onedrive_create_folder(path: String) -> Result<(), String> {
    let path = normalize_path(&path, false)?;
    let tokens = session().await?;
    onedrive_ops::create_folder(&tokens, &path).await
}

#[tauri::command]
pub async fn onedrive_download(path: String) -> Result<String, String> {
    let path = normalize_path(&path, false)?;
    let tokens = session().await?;
    let bytes = onedrive_ops::download(&tokens, &path).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn onedrive_delete(path: String) -> Result<(), String> {
    let path = normalize_path(&path, false)?;
    let tokens = session().await?;
    onedrive_ops::delete(&tokens, &path).await
}
