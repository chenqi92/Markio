// 阿里云盘集成：OAuth2 扫码授权（QR）+ openFile API（基于 file_id 寻址，类似 Google Drive）。
//
// 扫码流程：authorize/qrcode 拿 qrCodeUrl + sid → 用户手机扫码授权 → 轮询 status 拿 authCode
// → access_token 交换 token → getDriveInfo 拿 default_drive_id。
// 上传走 openFile/create（拿 upload_url）→ PUT 分片 → openFile/complete。
//
// appId / appSecret 由编译期内置（builtin_credentials）。
//
// 文档：https://www.alipan.com/developer/...（openFile list/create/complete/getDownloadUrl/recyclebin）

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_ALIYUN_OBJECT: usize = 50 * 1024 * 1024;

const API: &str = "https://openapi.alipan.com";
const SCOPES: &str = "user:base,file:all:read,file:all:write";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliyunTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub drive_id: String,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliyunStatus {
    pub connected: bool,
    pub display: String,
    pub expires_in_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliyunQr {
    pub qr_code_url: String,
    pub sid: String,
}

/// 扫码轮询结果。status: WaitLogin / ScanSuccess / LoginSuccess / QRCodeExpired。
/// LoginSuccess 时 status=connected 且已存好 token。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliyunQrPoll {
    pub status: String,
    pub connected: bool,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliyunEntry {
    pub file_id: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AliyunList {
    pub entries: Vec<AliyunEntry>,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

async fn post_json(
    client: &reqwest::Client,
    path: &str,
    token: Option<&str>,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut req = client
        .post(format!("{API}{path}"))
        .header("Content-Type", "application/json");
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("阿里云盘 {path} 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("阿里云盘 {path} HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("阿里云盘 {path} 解析失败：{e}; body={text}"))
}

// ─── OAuth 扫码 ─────────────────────────────────────────────────

pub async fn qr_start(client_id: &str, client_secret: &str) -> Result<AliyunQr, String> {
    let client = http()?;
    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": SCOPES.split(',').collect::<Vec<_>>(),
        "width": 430,
        "height": 430,
    });
    let v = post_json(&client, "/oauth/authorize/qrcode", None, body).await?;
    let qr = v.get("qrCodeUrl").and_then(|x| x.as_str()).ok_or("阿里云盘未返回 qrCodeUrl")?;
    let sid = v.get("sid").and_then(|x| x.as_str()).ok_or("阿里云盘未返回 sid")?;
    Ok(AliyunQr {
        qr_code_url: qr.to_string(),
        sid: sid.to_string(),
    })
}

/// 轮询扫码状态。LoginSuccess 时换取 token 并返回（含 auth_code → token），否则返回当前 status。
pub async fn qr_poll(
    client_id: &str,
    client_secret: &str,
    sid: &str,
) -> Result<(String, Option<AliyunTokens>), String> {
    let client = http()?;
    let resp = client
        .get(format!("{API}/oauth/qrcode/{sid}/status"))
        .send()
        .await
        .map_err(|e| format!("阿里云盘扫码状态失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("扫码状态解析失败：{e}"))?;
    let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("WaitLogin").to_string();
    if status != "LoginSuccess" {
        return Ok((status, None));
    }
    let auth_code = v
        .get("authCode")
        .and_then(|c| c.as_str())
        .ok_or("阿里云盘 LoginSuccess 未返回 authCode")?;
    let tokens = exchange_code(client_id, client_secret, auth_code).await?;
    Ok((status, Some(tokens)))
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    auth_code: &str,
) -> Result<AliyunTokens, String> {
    let client = http()?;
    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "authorization_code",
        "code": auth_code,
    });
    let v = post_json(&client, "/oauth/access_token", None, body).await?;
    let mut tokens = parse_token(&v)?;
    fill_drive_and_name(&mut tokens).await?;
    Ok(tokens)
}

fn parse_token(v: &serde_json::Value) -> Result<AliyunTokens, String> {
    let access_token = v.get("access_token").and_then(|x| x.as_str()).ok_or("阿里云盘未返回 access_token")?;
    let refresh_token = v.get("refresh_token").and_then(|x| x.as_str()).unwrap_or("");
    let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(7200);
    Ok(AliyunTokens {
        access_token: access_token.to_string(),
        refresh_token: refresh_token.to_string(),
        expires_at: now_epoch() + expires_in,
        drive_id: String::new(),
        display: String::new(),
    })
}

async fn fill_drive_and_name(tokens: &mut AliyunTokens) -> Result<(), String> {
    let client = http()?;
    let v = post_json(
        &client,
        "/adrive/v1.0/user/getDriveInfo",
        Some(&tokens.access_token),
        serde_json::json!({}),
    )
    .await?;
    let drive = v
        .get("default_drive_id")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("backup_drive_id").and_then(|x| x.as_str()))
        .or_else(|| v.get("resource_drive_id").and_then(|x| x.as_str()))
        .ok_or("阿里云盘未返回 drive_id")?;
    tokens.drive_id = drive.to_string();
    tokens.display = v
        .get("name")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("user_name").and_then(|x| x.as_str()))
        .unwrap_or("阿里云盘用户")
        .to_string();
    Ok(())
}

pub async fn refresh(
    tokens: &mut AliyunTokens,
    client_id: &str,
    client_secret: &str,
) -> Result<(), String> {
    if tokens.refresh_token.is_empty() {
        return Err("阿里云盘 refresh_token 缺失，请重新授权".to_string());
    }
    let client = http()?;
    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
        "refresh_token": tokens.refresh_token,
    });
    let v = post_json(&client, "/oauth/access_token", None, body).await?;
    let parsed = parse_token(&v)?;
    tokens.access_token = parsed.access_token;
    if !parsed.refresh_token.is_empty() {
        tokens.refresh_token = parsed.refresh_token;
    }
    tokens.expires_at = parsed.expires_at;
    Ok(())
}

pub async fn ensure_fresh(
    tokens: &mut AliyunTokens,
    client_id: &str,
    client_secret: &str,
) -> Result<bool, String> {
    if tokens.expires_at > now_epoch() + 60 {
        return Ok(false);
    }
    refresh(tokens, client_id, client_secret).await?;
    Ok(true)
}

// ─── 文件 API（file_id 寻址）────────────────────────────────────

pub async fn list(tokens: &AliyunTokens, parent_file_id: &str) -> Result<AliyunList, String> {
    let client = http()?;
    let mut entries = Vec::new();
    let mut marker = String::new();
    loop {
        let mut body = serde_json::json!({
            "drive_id": tokens.drive_id,
            "parent_file_id": if parent_file_id.is_empty() { "root" } else { parent_file_id },
            "limit": 100,
        });
        if !marker.is_empty() {
            body["marker"] = serde_json::Value::String(marker.clone());
        }
        let v = post_json(&client, "/adrive/v1.0/openFile/list", Some(&tokens.access_token), body).await?;
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        for it in items {
            let ty = it.get("type").and_then(|x| x.as_str()).unwrap_or("file");
            entries.push(AliyunEntry {
                file_id: it.get("file_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                name: it.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                is_dir: ty == "folder",
                size: it.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
                mtime: it.get("updated_at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                content_hash: it.get("content_hash").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
        marker = v.get("next_marker").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if marker.is_empty() {
            break;
        }
    }
    Ok(AliyunList { entries })
}

pub async fn download(tokens: &AliyunTokens, file_id: &str) -> Result<Vec<u8>, String> {
    let client = http()?;
    let v = post_json(
        &client,
        "/adrive/v1.0/openFile/getDownloadUrl",
        Some(&tokens.access_token),
        serde_json::json!({ "drive_id": tokens.drive_id, "file_id": file_id }),
    )
    .await?;
    let url = v.get("url").and_then(|x| x.as_str()).ok_or("阿里云盘未返回下载 url")?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("阿里云盘下载失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("阿里云盘下载 HTTP {status}: {t}"));
    }
    crate::read_capped(resp, MAX_ALIYUN_OBJECT, "阿里云盘").await
}

pub async fn create_folder(
    tokens: &AliyunTokens,
    parent_file_id: &str,
    name: &str,
) -> Result<String, String> {
    let client = http()?;
    let body = serde_json::json!({
        "drive_id": tokens.drive_id,
        "parent_file_id": if parent_file_id.is_empty() { "root" } else { parent_file_id },
        "name": name,
        "type": "folder",
        "check_name_mode": "refuse",
    });
    let v = post_json(&client, "/adrive/v1.0/openFile/create", Some(&tokens.access_token), body).await?;
    Ok(v.get("file_id").and_then(|x| x.as_str()).unwrap_or("").to_string())
}

/// 上传文件。existing_file_id 非空时先回收旧文件再建新（覆盖语义）。返回新 file_id。
pub async fn upload(
    tokens: &AliyunTokens,
    parent_file_id: &str,
    name: &str,
    existing_file_id: Option<&str>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.len() > MAX_ALIYUN_OBJECT {
        return Err(format!("阿里云盘单文件上传超过上限：{} > {}", bytes.len(), MAX_ALIYUN_OBJECT));
    }
    let client = http()?;
    if let Some(id) = existing_file_id {
        if !id.is_empty() {
            let _ = delete(tokens, id).await; // 覆盖：忽略删除失败（可能已不存在）
        }
    }
    // 1) create 拿 upload_url
    let create_body = serde_json::json!({
        "drive_id": tokens.drive_id,
        "parent_file_id": if parent_file_id.is_empty() { "root" } else { parent_file_id },
        "name": name,
        "type": "file",
        "check_name_mode": "auto_rename",
        "size": bytes.len(),
        "part_info_list": [ { "part_number": 1 } ],
    });
    let v = post_json(&client, "/adrive/v1.0/openFile/create", Some(&tokens.access_token), create_body).await?;
    let file_id = v.get("file_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let upload_id = v.get("upload_id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let rapid = v.get("rapid_upload").and_then(|x| x.as_bool()).unwrap_or(false);

    if !rapid {
        let upload_url = v
            .get("part_info_list")
            .and_then(|p| p.as_array())
            .and_then(|a| a.first())
            .and_then(|p| p.get("upload_url"))
            .and_then(|u| u.as_str())
            .ok_or("阿里云盘未返回 upload_url")?
            .to_string();
        // 2) PUT 分片（upload_url 已预签名，不带 bearer）
        let resp = client
            .put(&upload_url)
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("阿里云盘分片上传失败：{e}"))?;
        let st = resp.status();
        if !st.is_success() {
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("阿里云盘分片上传 HTTP {st}: {t}"));
        }
        // 3) complete
        let complete_body = serde_json::json!({
            "drive_id": tokens.drive_id,
            "file_id": file_id,
            "upload_id": upload_id,
        });
        post_json(&client, "/adrive/v1.0/openFile/complete", Some(&tokens.access_token), complete_body).await?;
    }
    Ok(file_id)
}

pub async fn delete(tokens: &AliyunTokens, file_id: &str) -> Result<(), String> {
    let client = http()?;
    // 移入回收站（比永久删除安全）
    let body = serde_json::json!({ "drive_id": tokens.drive_id, "file_id": file_id });
    post_json(&client, "/adrive/v1.0/openFile/recyclebin/trash", Some(&tokens.access_token), body).await?;
    Ok(())
}
