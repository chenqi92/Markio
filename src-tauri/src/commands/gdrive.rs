//! Google Drive OAuth + 文件 API：authorize / status / signout / list / upload / download / delete。
//!
//! tokens / client_id 同样存钥匙串；OAuth 走 PKCE + loopback redirect。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{gdrive_ops, oauth, secrets, validate_body_size, MAX_SYNC_BODY_BYTES};

const GDRIVE_TOKENS_ACCOUNT: &str = "gdrive:tokens";
const GDRIVE_CLIENT_ACCOUNT: &str = "gdrive:client_id";

fn load_gdrive_tokens() -> Result<gdrive_ops::GDriveTokens, String> {
    let raw =
        secrets::get(GDRIVE_TOKENS_ACCOUNT)?.ok_or_else(|| "尚未授权 Google Drive".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("Drive token 解析失败：{e}"))
}

fn save_gdrive_tokens(tokens: &gdrive_ops::GDriveTokens) -> Result<(), String> {
    let s = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    secrets::set(GDRIVE_TOKENS_ACCOUNT, &s)
}

async fn gdrive_session() -> Result<(gdrive_ops::GDriveTokens, String), String> {
    let mut tokens = load_gdrive_tokens()?;
    let client_id =
        secrets::get(GDRIVE_CLIENT_ACCOUNT)?.ok_or_else(|| "Drive client_id 丢失".to_string())?;
    let before = tokens.access_token.clone();
    gdrive_ops::ensure_fresh(&mut tokens, &client_id).await?;
    // 仅在 token 实际刷新后回写钥匙串
    if tokens.access_token != before {
        save_gdrive_tokens(&tokens)?;
    }
    Ok((tokens, client_id))
}

#[tauri::command]
pub async fn gdrive_authorize(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<gdrive_ops::GDriveStatus, String> {
    use tauri_plugin_opener::OpenerExt as _;
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Google client_id 为空".to_string());
    }
    let pkce = oauth::PkcePair::new()?;
    let state = oauth::random_state()?;
    let listener = oauth::LoopbackListener::bind().await?;
    let redirect = listener.redirect_uri();
    let url = gdrive_ops::build_authorize_url(&client_id, &redirect, &pkce.challenge, &state);
    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("打开浏览器失败：{e}"))?;
    let code = listener
        .wait_for_code(std::time::Duration::from_secs(300), Some(&state))
        .await?;
    let tokens = gdrive_ops::exchange_code(&client_id, &code, &pkce.verifier, &redirect).await?;
    save_gdrive_tokens(&tokens)?;
    secrets::set(GDRIVE_CLIENT_ACCOUNT, &client_id)?;
    Ok(gdrive_ops::GDriveStatus {
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
pub fn gdrive_status() -> Result<gdrive_ops::GDriveStatus, String> {
    match load_gdrive_tokens() {
        Ok(t) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Ok(gdrive_ops::GDriveStatus {
                connected: true,
                display: t.display,
                expires_in_secs: t.expires_at as i64 - now,
            })
        }
        Err(_) => Ok(gdrive_ops::GDriveStatus {
            connected: false,
            display: String::new(),
            expires_in_secs: 0,
        }),
    }
}

#[tauri::command]
pub fn gdrive_signout() -> Result<(), String> {
    // 聚合两个删除的错误并返回，删除失败时不静默显示"已登出"
    let a = secrets::delete(GDRIVE_TOKENS_ACCOUNT);
    let b = secrets::delete(GDRIVE_CLIENT_ACCOUNT);
    a.and(b)
}

#[tauri::command]
pub async fn gdrive_list(
    q: String,
    page_token: Option<String>,
) -> Result<gdrive_ops::GDriveList, String> {
    let (tokens, _) = gdrive_session().await?;
    gdrive_ops::list_files(&tokens, &q, page_token.as_deref()).await
}

#[tauri::command]
pub async fn gdrive_upload(
    name: String,
    parent_id: Option<String>,
    existing_id: Option<String>,
    body_base64: String,
    mime_type: String,
) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.is_empty() {
        return Err("Drive 文件名无效".to_string());
    }
    validate_body_size("Drive 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    let (tokens, _) = gdrive_session().await?;
    gdrive_ops::upload(
        &tokens,
        existing_id.as_deref().filter(|s| !s.is_empty()),
        &name,
        parent_id.as_deref().filter(|s| !s.is_empty()),
        bytes,
        &mime_type,
    )
    .await
}

#[tauri::command]
pub async fn gdrive_create_folder(
    name: String,
    parent_id: Option<String>,
) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.trim().is_empty() || name.len() > 255 {
        return Err("Drive 文件夹名无效".to_string());
    }
    let (tokens, _) = gdrive_session().await?;
    gdrive_ops::create_folder(
        &tokens,
        name.trim(),
        parent_id.as_deref().filter(|s| !s.is_empty()),
    )
    .await
}

#[tauri::command]
pub async fn gdrive_download(file_id: String) -> Result<String, String> {
    if file_id.is_empty() {
        return Err("file_id 为空".to_string());
    }
    let (tokens, _) = gdrive_session().await?;
    let bytes = gdrive_ops::download(&tokens, &file_id).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn gdrive_delete(file_id: String) -> Result<(), String> {
    if file_id.is_empty() {
        return Err("file_id 为空".to_string());
    }
    let (tokens, _) = gdrive_session().await?;
    gdrive_ops::delete(&tokens, &file_id).await
}
