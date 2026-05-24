//! S3 兼容上传：put / list / get / delete / set_secret / has_secret。
//!
//! secret_access_key 走钥匙串 s3:<endpoint host>，密码不出 Rust 进程。

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    remote_account, s3_ops, secrets, validate_body_size, validate_http_service_url,
    validate_remote_rel_path, MAX_SYNC_BODY_BYTES,
};

fn resolve_s3_secret_key(endpoint: &str, explicit: &str) -> String {
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    let account = remote_account("s3", endpoint).unwrap_or_else(|_| "s3:invalid".to_string());
    secrets::get(&account).ok().flatten().unwrap_or_default()
}

#[tauri::command]
pub async fn s3_put_object(
    cfg: s3_ops::S3Config,
    key: String,
    body_base64: String,
    content_type: String,
) -> Result<String, String> {
    validate_http_service_url(&cfg.endpoint, "S3 endpoint")?;
    if let Some(public) = cfg
        .public_base_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        validate_http_service_url(public, "S3 public URL")?;
    }
    validate_remote_rel_path(&key, false)?;
    validate_body_size("S3 上传内容", &body_base64, MAX_SYNC_BODY_BYTES)?;
    let mut cfg = cfg;
    cfg.secret_access_key = resolve_s3_secret_key(&cfg.endpoint, &cfg.secret_access_key);
    let bytes = STANDARD
        .decode(body_base64)
        .map_err(|e| format!("body 不是合法 base64：{e}"))?;
    s3_ops::put_object(&cfg, &key, bytes, &content_type).await
}

#[tauri::command]
pub fn s3_set_secret(endpoint: String, secret_access_key: String) -> Result<(), String> {
    let account = remote_account("s3", &endpoint)?;
    if secret_access_key.is_empty() {
        secrets::delete(&account)
    } else {
        secrets::set(&account, &secret_access_key)
    }
}

#[tauri::command]
pub fn s3_has_secret(endpoint: String) -> Result<bool, String> {
    let account = remote_account("s3", &endpoint)?;
    Ok(secrets::has(&account))
}

#[tauri::command]
pub async fn s3_list_objects(
    cfg: s3_ops::S3Config,
    prefix: String,
    continuation_token: Option<String>,
    max_keys: Option<u32>,
) -> Result<s3_ops::S3ListResult, String> {
    validate_http_service_url(&cfg.endpoint, "S3 endpoint")?;
    let mut cfg = cfg;
    cfg.secret_access_key = resolve_s3_secret_key(&cfg.endpoint, &cfg.secret_access_key);
    s3_ops::list_objects(
        &cfg,
        &prefix,
        continuation_token.as_deref(),
        max_keys.unwrap_or(200),
    )
    .await
}

#[tauri::command]
pub async fn s3_get_object(cfg: s3_ops::S3Config, key: String) -> Result<String, String> {
    validate_http_service_url(&cfg.endpoint, "S3 endpoint")?;
    validate_remote_rel_path(&key, false)?;
    let mut cfg = cfg;
    cfg.secret_access_key = resolve_s3_secret_key(&cfg.endpoint, &cfg.secret_access_key);
    let bytes = s3_ops::get_object(&cfg, &key).await?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn s3_delete_object(cfg: s3_ops::S3Config, key: String) -> Result<(), String> {
    validate_http_service_url(&cfg.endpoint, "S3 endpoint")?;
    validate_remote_rel_path(&key, false)?;
    let mut cfg = cfg;
    cfg.secret_access_key = resolve_s3_secret_key(&cfg.endpoint, &cfg.secret_access_key);
    s3_ops::delete_object(&cfg, &key).await
}
