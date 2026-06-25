//! Synology FileStation 命令：set_password / has_password / login / list / download /
//! upload / create_folder / delete。
//!
//! 密码进钥匙串（synology:<host:port>），sid 由前端在一次同步内复用，每次操作把
//! base_url / insecure_tls / sid 作为参数传入（参照 S3 的无状态命令风格）。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{secrets, synology_ops, validate_body_size, MAX_SYNC_BODY_BYTES};

fn account_key(base: &str) -> Result<String, String> {
    let norm = synology_ops::validate_base_url(base)?;
    let url = reqwest::Url::parse(&norm).map_err(|e| e.to_string())?;
    let host = url
        .host_str()
        .ok_or_else(|| "Synology 地址缺少 host".to_string())?
        .to_ascii_lowercase();
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    Ok(format!("synology:{authority}"))
}

/// 设备令牌（2FA 记住设备）在钥匙串里的 key
fn device_key(base: &str) -> Result<String, String> {
    Ok(format!("{}:did", account_key(base)?))
}

/// NAS 绝对路径校验：必须以 / 开头，无控制字符 / .. 段。
fn validate_abs_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("Synology 路径必须以 / 开头".to_string());
    }
    if path.contains('\n') || path.contains('\r') || path.contains('\0') {
        return Err("Synology 路径含非法控制字符".to_string());
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err("Synology 路径不能包含 ..".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn synology_set_password(base_url: String, password: String) -> Result<(), String> {
    let key = account_key(&base_url)?;
    secrets::set(&key, &password)
}

#[tauri::command]
pub fn synology_has_password(base_url: String) -> Result<bool, String> {
    let key = account_key(&base_url)?;
    Ok(secrets::has(&key))
}

#[tauri::command]
pub async fn synology_login(
    base_url: String,
    insecure_tls: bool,
    account: String,
    otp_code: Option<String>,
) -> Result<synology_ops::SynologyLogin, String> {
    let base = synology_ops::validate_base_url(&base_url)?;
    let account = account.trim();
    if account.is_empty() {
        return Err("Synology 账号为空".to_string());
    }
    let key = account_key(&base_url)?;
    let password = secrets::get(&key)?.ok_or_else(|| "尚未保存 Synology 密码".to_string())?;
    // 自动复用上次记住的设备令牌 → 2FA 账号自动同步重登无需再输 OTP
    let did_key = device_key(&base_url)?;
    let stored_did = secrets::get(&did_key)?;
    let raw = synology_ops::login(
        &base,
        insecure_tls,
        account,
        &password,
        otp_code.as_deref().filter(|s| !s.is_empty()),
        stored_did.as_deref().filter(|s| !s.is_empty()),
    )
    .await?;
    // 本次拿到新设备令牌就存起来（2FA + OTP 首次登录会返回）
    if let Some(did) = &raw.did {
        secrets::set(&did_key, did)?;
    }
    let device_remembered = raw.did.is_some() || stored_did.is_some();
    Ok(synology_ops::SynologyLogin {
        sid: raw.sid,
        device_remembered,
    })
}

#[tauri::command]
pub async fn synology_list(
    base_url: String,
    insecure_tls: bool,
    sid: String,
    folder_path: String,
) -> Result<synology_ops::SynologyList, String> {
    let base = synology_ops::validate_base_url(&base_url)?;
    validate_abs_path(&folder_path)?;
    synology_ops::list(&base, insecure_tls, &sid, &folder_path).await
}

#[tauri::command]
pub async fn synology_download(
    base_url: String,
    insecure_tls: bool,
    sid: String,
    path: String,
) -> Result<String, String> {
    let base = synology_ops::validate_base_url(&base_url)?;
    validate_abs_path(&path)?;
    let bytes = synology_ops::download(&base, insecure_tls, &sid, &path).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn synology_upload(
    base_url: String,
    insecure_tls: bool,
    sid: String,
    dest_folder: String,
    name: String,
    body_base64: String,
) -> Result<(), String> {
    let base = synology_ops::validate_base_url(&base_url)?;
    validate_abs_path(&dest_folder)?;
    validate_body_size("Synology 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    synology_ops::upload(&base, insecure_tls, &sid, &dest_folder, &name, bytes).await
}

#[tauri::command]
pub async fn synology_create_folder(
    base_url: String,
    insecure_tls: bool,
    sid: String,
    parent_path: String,
    name: String,
) -> Result<(), String> {
    let base = synology_ops::validate_base_url(&base_url)?;
    validate_abs_path(&parent_path)?;
    if name.contains('/') || name.contains('\\') || name.trim().is_empty() {
        return Err("Synology 文件夹名无效".to_string());
    }
    synology_ops::create_folder(&base, insecure_tls, &sid, &parent_path, name.trim()).await
}

#[tauri::command]
pub async fn synology_delete(
    base_url: String,
    insecure_tls: bool,
    sid: String,
    path: String,
) -> Result<(), String> {
    let base = synology_ops::validate_base_url(&base_url)?;
    validate_abs_path(&path)?;
    synology_ops::delete(&base, insecure_tls, &sid, &path).await
}
