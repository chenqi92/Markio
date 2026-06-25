//! 百度网盘命令：device_start / device_poll / status / signout / list / download / upload /
//! create_folder / delete。
//!
//! 设备码授权：device_start 拿 user_code + 验证地址，前端引导用户授权，再轮询 device_poll。
//! client_id(AppKey) / client_secret 从编译期内置凭据取（builtin_credentials）。tokens 进钥匙串。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{baidu_ops, builtin_credentials, secrets, validate_body_size, MAX_SYNC_BODY_BYTES};

const BAIDU_TOKENS_ACCOUNT: &str = "baidu:tokens";

fn creds() -> Result<(String, String), String> {
    let id = builtin_credentials::client_id("baidu")
        .ok_or_else(|| "本版本未内置百度网盘凭据（AppKey），无法使用".to_string())?;
    let secret = builtin_credentials::client_secret("baidu")
        .ok_or_else(|| "本版本未内置百度网盘 SecretKey，无法使用".to_string())?;
    Ok((id.to_string(), secret.to_string()))
}

fn load_tokens() -> Result<baidu_ops::BaiduTokens, String> {
    let raw = secrets::get(BAIDU_TOKENS_ACCOUNT)?.ok_or_else(|| "尚未授权百度网盘".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("百度 token 解析失败：{e}"))
}

fn save_tokens(tokens: &baidu_ops::BaiduTokens) -> Result<(), String> {
    let s = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    secrets::set(BAIDU_TOKENS_ACCOUNT, &s)
}

async fn session() -> Result<baidu_ops::BaiduTokens, String> {
    let (id, secret) = creds()?;
    let mut tokens = load_tokens()?;
    if baidu_ops::ensure_fresh(&mut tokens, &id, &secret).await? {
        save_tokens(&tokens)?;
    }
    Ok(tokens)
}

fn validate_abs_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("百度路径必须以 / 开头".to_string());
    }
    if path.contains('\n') || path.contains('\r') || path.contains('\0') {
        return Err("百度路径含非法控制字符".to_string());
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err("百度路径不能包含 ..".to_string());
    }
    Ok(())
}

fn status_of(t: &baidu_ops::BaiduTokens) -> baidu_ops::BaiduStatus {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    baidu_ops::BaiduStatus {
        connected: true,
        display: t.display.clone(),
        expires_in_secs: t.expires_at as i64 - now,
    }
}

#[tauri::command]
pub async fn baidu_device_start() -> Result<baidu_ops::BaiduDeviceCode, String> {
    let (id, _) = creds()?;
    baidu_ops::device_code(&id).await
}

/// 轮询一次设备码授权。None = 仍在等待用户授权；Some = 授权完成（token 已存钥匙串）。
#[tauri::command]
pub async fn baidu_device_poll(
    device_code: String,
) -> Result<Option<baidu_ops::BaiduStatus>, String> {
    let (id, secret) = creds()?;
    match baidu_ops::device_poll(&id, &secret, &device_code).await? {
        Some(tokens) => {
            save_tokens(&tokens)?;
            Ok(Some(status_of(&tokens)))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn baidu_status() -> Result<baidu_ops::BaiduStatus, String> {
    match load_tokens() {
        Ok(t) => Ok(status_of(&t)),
        Err(_) => Ok(baidu_ops::BaiduStatus {
            connected: false,
            display: String::new(),
            expires_in_secs: 0,
        }),
    }
}

#[tauri::command]
pub fn baidu_signout() -> Result<(), String> {
    secrets::delete(BAIDU_TOKENS_ACCOUNT)
}

#[tauri::command]
pub async fn baidu_list(dir: String) -> Result<baidu_ops::BaiduList, String> {
    validate_abs_path(&dir)?;
    let tokens = session().await?;
    baidu_ops::list(&tokens, &dir).await
}

#[tauri::command]
pub async fn baidu_download(fs_id: String) -> Result<String, String> {
    let tokens = session().await?;
    let bytes = baidu_ops::download(&tokens, &fs_id).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn baidu_upload(path: String, body_base64: String) -> Result<(), String> {
    validate_abs_path(&path)?;
    validate_body_size("百度上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    let tokens = session().await?;
    baidu_ops::upload(&tokens, &path, bytes).await
}

#[tauri::command]
pub async fn baidu_create_folder(path: String) -> Result<(), String> {
    validate_abs_path(&path)?;
    let tokens = session().await?;
    baidu_ops::create_folder(&tokens, &path).await
}

#[tauri::command]
pub async fn baidu_delete(path: String) -> Result<(), String> {
    validate_abs_path(&path)?;
    let tokens = session().await?;
    baidu_ops::delete(&tokens, &path).await
}
