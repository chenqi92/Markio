//! WebDAV 同步：test / list / put / get / delete / mkcol / set_password / has_password。
//!
//! 密码走 OS 钥匙串（webdav:<host>），上传 base64 + 50MB 上限。
//! 实际 HTTP 调用在 webdav_ops。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    remote_account, secrets, validate_body_size, validate_http_service_url,
    validate_remote_rel_path, webdav_ops, MAX_SYNC_BODY_BYTES,
};

fn webdav_keychain_account(base_url: &str) -> Result<String, String> {
    remote_account("webdav", base_url)
}

fn resolve_webdav_password(base_url: &str, explicit: &str) -> Result<String, String> {
    if !explicit.is_empty() {
        return Ok(explicit.to_string());
    }
    let account = webdav_keychain_account(base_url)?;
    Ok(secrets::get(&account).ok().flatten().unwrap_or_default())
}

#[tauri::command]
pub async fn webdav_test(base_url: String, auth: webdav_ops::WebDavAuth) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::test(&base_url, &auth).await
}

#[tauri::command]
pub async fn webdav_list(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    path: String,
) -> Result<Vec<webdav_ops::WebDavEntry>, String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&path, true)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::list(&base_url, &auth, &path).await
}

#[tauri::command]
pub async fn webdav_put(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
    body_base64: String,
) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    validate_body_size("WebDAV 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    webdav_ops::put(&base_url, &auth, &rel_path, bytes).await
}

#[tauri::command]
pub async fn webdav_get(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
) -> Result<String, String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    let bytes = webdav_ops::get(&base_url, &auth, &rel_path).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn webdav_delete(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::delete(&base_url, &auth, &rel_path).await
}

#[tauri::command]
pub async fn webdav_mkcol(
    base_url: String,
    auth: webdav_ops::WebDavAuth,
    rel_path: String,
) -> Result<(), String> {
    validate_http_service_url(&base_url, "WebDAV")?;
    validate_remote_rel_path(&rel_path, false)?;
    let mut auth = auth;
    auth.password = resolve_webdav_password(&base_url, &auth.password)?;
    webdav_ops::mkcol(&base_url, &auth, &rel_path).await
}

#[tauri::command]
pub fn webdav_set_password(base_url: String, password: String) -> Result<(), String> {
    let account = webdav_keychain_account(&base_url)?;
    if password.is_empty() {
        secrets::delete(&account)
    } else {
        secrets::set(&account, &password)
    }
}

#[tauri::command]
pub fn webdav_has_password(base_url: String) -> Result<bool, String> {
    let account = webdav_keychain_account(&base_url)?;
    Ok(secrets::has(&account))
}
