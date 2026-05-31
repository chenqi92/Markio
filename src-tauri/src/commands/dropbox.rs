//! Dropbox OAuth + 文件 API：authorize / status / signout / list / upload / download / delete。
//!
//! tokens 存钥匙串（dropbox:tokens），client_id 同样存钥匙串。
//! OAuth 走 PKCE + loopback redirect。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    dropbox_ops, oauth, secrets, validate_body_size, validate_remote_rel_path, MAX_SYNC_BODY_BYTES,
};

const DROPBOX_TOKENS_ACCOUNT: &str = "dropbox:tokens";
const DROPBOX_CLIENT_ACCOUNT: &str = "dropbox:client_id";

fn load_dropbox_tokens() -> Result<dropbox_ops::DropboxTokens, String> {
    let raw =
        secrets::get(DROPBOX_TOKENS_ACCOUNT)?.ok_or_else(|| "尚未授权 Dropbox".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Dropbox token 解析失败：{e}"))
}

fn save_dropbox_tokens(tokens: &dropbox_ops::DropboxTokens) -> Result<(), String> {
    let s = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    secrets::set(DROPBOX_TOKENS_ACCOUNT, &s)
}

async fn dropbox_session() -> Result<(dropbox_ops::DropboxTokens, String), String> {
    let mut tokens = load_dropbox_tokens()?;
    let client_id = secrets::get(DROPBOX_CLIENT_ACCOUNT)?
        .ok_or_else(|| "Dropbox client_id 丢失".to_string())?;
    dropbox_ops::ensure_fresh(&mut tokens, &client_id).await?;
    save_dropbox_tokens(&tokens)?;
    Ok((tokens, client_id))
}

fn normalize_dropbox_path(path: &str, allow_root: bool) -> Result<String, String> {
    let trimmed = path.trim();
    let without_slash = trimmed.trim_start_matches('/');
    validate_remote_rel_path(without_slash, allow_root)?;
    if without_slash.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!("/{without_slash}"))
    }
}

#[tauri::command]
pub async fn dropbox_authorize(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<dropbox_ops::DropboxStatus, String> {
    use tauri_plugin_opener::OpenerExt as _;
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Dropbox client_id 为空".to_string());
    }
    let pkce = oauth::PkcePair::new()?;
    let state = oauth::random_state()?;
    let listener = oauth::LoopbackListener::bind().await?;
    let redirect = listener.redirect_uri();
    let url = dropbox_ops::build_authorize_url(&client_id, &redirect, &pkce.challenge, &state);
    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    let code = listener
        .wait_for_code(std::time::Duration::from_secs(300), Some(&state))
        .await?;
    let tokens = dropbox_ops::exchange_code(&client_id, &code, &pkce.verifier, &redirect).await?;
    save_dropbox_tokens(&tokens)?;
    secrets::set(DROPBOX_CLIENT_ACCOUNT, &client_id)?;
    Ok(dropbox_ops::DropboxStatus {
        connected: true,
        display: tokens.display,
        account_id: tokens.account_id,
        expires_in_secs: (tokens.expires_at as i64)
            - (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)),
    })
}

#[tauri::command]
pub fn dropbox_status() -> Result<dropbox_ops::DropboxStatus, String> {
    match load_dropbox_tokens() {
        Ok(t) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Ok(dropbox_ops::DropboxStatus {
                connected: true,
                display: t.display,
                account_id: t.account_id,
                expires_in_secs: t.expires_at as i64 - now,
            })
        }
        Err(_) => Ok(dropbox_ops::DropboxStatus {
            connected: false,
            display: String::new(),
            account_id: String::new(),
            expires_in_secs: 0,
        }),
    }
}

#[tauri::command]
pub fn dropbox_signout() -> Result<(), String> {
    let _ = secrets::delete(DROPBOX_TOKENS_ACCOUNT);
    let _ = secrets::delete(DROPBOX_CLIENT_ACCOUNT);
    Ok(())
}

#[tauri::command]
pub async fn dropbox_list(path: String) -> Result<dropbox_ops::DropboxList, String> {
    let path = normalize_dropbox_path(&path, true)?;
    let (tokens, _) = dropbox_session().await?;
    dropbox_ops::list_folder(&tokens, &path).await
}

#[tauri::command]
pub async fn dropbox_list_continue(cursor: String) -> Result<dropbox_ops::DropboxList, String> {
    let cursor = cursor.trim();
    if cursor.is_empty() || cursor.len() > 4096 {
        return Err("Dropbox cursor 无效".to_string());
    }
    let (tokens, _) = dropbox_session().await?;
    dropbox_ops::list_folder_continue(&tokens, cursor).await
}

#[tauri::command]
pub async fn dropbox_upload(path: String, body_base64: String) -> Result<(), String> {
    let path = normalize_dropbox_path(&path, false)?;
    validate_body_size("Dropbox 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    let (tokens, _) = dropbox_session().await?;
    dropbox_ops::upload(&tokens, &path, bytes).await
}

#[tauri::command]
pub async fn dropbox_create_folder(path: String) -> Result<(), String> {
    let path = normalize_dropbox_path(&path, false)?;
    let (tokens, _) = dropbox_session().await?;
    dropbox_ops::create_folder(&tokens, &path).await
}

#[tauri::command]
pub async fn dropbox_download(path: String) -> Result<String, String> {
    let path = normalize_dropbox_path(&path, false)?;
    let (tokens, _) = dropbox_session().await?;
    let bytes = dropbox_ops::download(&tokens, &path).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn dropbox_delete(path: String) -> Result<(), String> {
    let path = normalize_dropbox_path(&path, false)?;
    let (tokens, _) = dropbox_session().await?;
    dropbox_ops::delete(&tokens, &path).await
}
