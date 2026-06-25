//! 阿里云盘命令：qr_start / qr_poll / status / signout / list / download / upload /
//! create_folder / delete。
//!
//! 扫码授权：qr_start 拿二维码地址 + sid，前端展示二维码，再轮询 qr_poll。
//! appId / appSecret 从编译期内置凭据取（builtin_credentials）。tokens（含 drive_id）进钥匙串。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{aliyun_ops, builtin_credentials, secrets, validate_body_size, MAX_SYNC_BODY_BYTES};

const ALIYUN_TOKENS_ACCOUNT: &str = "aliyun:tokens";

fn creds() -> Result<(String, String), String> {
    let id = builtin_credentials::client_id("aliyun")
        .ok_or_else(|| "本版本未内置阿里云盘凭据（appId），无法使用".to_string())?;
    let secret = builtin_credentials::client_secret("aliyun")
        .ok_or_else(|| "本版本未内置阿里云盘 appSecret，无法使用".to_string())?;
    Ok((id.to_string(), secret.to_string()))
}

fn load_tokens() -> Result<aliyun_ops::AliyunTokens, String> {
    let raw = secrets::get(ALIYUN_TOKENS_ACCOUNT)?.ok_or_else(|| "尚未授权阿里云盘".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("阿里云盘 token 解析失败：{e}"))
}

fn save_tokens(tokens: &aliyun_ops::AliyunTokens) -> Result<(), String> {
    let s = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    secrets::set(ALIYUN_TOKENS_ACCOUNT, &s)
}

async fn session() -> Result<aliyun_ops::AliyunTokens, String> {
    let (id, secret) = creds()?;
    let mut tokens = load_tokens()?;
    if aliyun_ops::ensure_fresh(&mut tokens, &id, &secret).await? {
        save_tokens(&tokens)?;
    }
    Ok(tokens)
}

fn status_of(t: &aliyun_ops::AliyunTokens) -> aliyun_ops::AliyunStatus {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    aliyun_ops::AliyunStatus {
        connected: true,
        display: t.display.clone(),
        expires_in_secs: t.expires_at as i64 - now,
    }
}

#[tauri::command]
pub async fn aliyun_qr_start() -> Result<aliyun_ops::AliyunQr, String> {
    let (id, secret) = creds()?;
    aliyun_ops::qr_start(&id, &secret).await
}

/// 轮询一次扫码状态。LoginSuccess 时换 token 并存钥匙串，connected=true。
#[tauri::command]
pub async fn aliyun_qr_poll(sid: String) -> Result<aliyun_ops::AliyunQrPoll, String> {
    let (id, secret) = creds()?;
    let (status, tokens) = aliyun_ops::qr_poll(&id, &secret, &sid).await?;
    match tokens {
        Some(t) => {
            save_tokens(&t)?;
            Ok(aliyun_ops::AliyunQrPoll {
                status,
                connected: true,
                display: t.display,
            })
        }
        None => Ok(aliyun_ops::AliyunQrPoll {
            status,
            connected: false,
            display: String::new(),
        }),
    }
}

#[tauri::command]
pub fn aliyun_status() -> Result<aliyun_ops::AliyunStatus, String> {
    match load_tokens() {
        Ok(t) => Ok(status_of(&t)),
        Err(_) => Ok(aliyun_ops::AliyunStatus {
            connected: false,
            display: String::new(),
            expires_in_secs: 0,
        }),
    }
}

#[tauri::command]
pub fn aliyun_signout() -> Result<(), String> {
    secrets::delete(ALIYUN_TOKENS_ACCOUNT)
}

#[tauri::command]
pub async fn aliyun_list(parent_file_id: String) -> Result<aliyun_ops::AliyunList, String> {
    let tokens = session().await?;
    aliyun_ops::list(&tokens, &parent_file_id).await
}

#[tauri::command]
pub async fn aliyun_download(file_id: String) -> Result<String, String> {
    if file_id.trim().is_empty() {
        return Err("阿里云盘 file_id 为空".to_string());
    }
    let tokens = session().await?;
    let bytes = aliyun_ops::download(&tokens, &file_id).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn aliyun_create_folder(
    parent_file_id: String,
    name: String,
) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.trim().is_empty() {
        return Err("阿里云盘文件夹名无效".to_string());
    }
    let tokens = session().await?;
    aliyun_ops::create_folder(&tokens, &parent_file_id, name.trim()).await
}

#[tauri::command]
pub async fn aliyun_upload(
    parent_file_id: String,
    name: String,
    existing_file_id: Option<String>,
    body_base64: String,
) -> Result<String, String> {
    if name.contains('/') || name.contains('\\') || name.trim().is_empty() {
        return Err("阿里云盘文件名无效".to_string());
    }
    validate_body_size("阿里云盘上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    let tokens = session().await?;
    aliyun_ops::upload(
        &tokens,
        &parent_file_id,
        name.trim(),
        existing_file_id.as_deref().filter(|s| !s.is_empty()),
        bytes,
    )
    .await
}

#[tauri::command]
pub async fn aliyun_delete(file_id: String) -> Result<(), String> {
    if file_id.trim().is_empty() {
        return Err("阿里云盘 file_id 为空".to_string());
    }
    let tokens = session().await?;
    aliyun_ops::delete(&tokens, &file_id).await
}
