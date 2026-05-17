// Google Drive 集成：OAuth2 PKCE 授权 + Drive v3 API（files.list / get / create / delete）。
//
// Google Cloud Console 注册的 OAuth Client（Desktop Application 类型）没有
// client_secret，PKCE 即可完成授权。client_id 运行时传入，token 存系统钥匙串。
//
// 文档：
//   - OAuth: https://developers.google.com/identity/protocols/oauth2/native-app
//   - Drive: https://developers.google.com/drive/api/v3/reference

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_GDRIVE_OBJECT: usize = 50 * 1024 * 1024;

const AUTH_HOST: &str = "https://accounts.google.com";
const TOKEN_HOST: &str = "https://oauth2.googleapis.com";
const API_HOST: &str = "https://www.googleapis.com";

/// 申请的 scope：drive.file 只能访问 markio 创建/打开的文件，最小化权限
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GDriveTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GDriveStatus {
    pub connected: bool,
    pub display: String,
    pub expires_in_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GDriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub modified_time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GDriveList {
    pub files: Vec<GDriveFile>,
    pub next_page_token: Option<String>,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn build_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
) -> String {
    let q = [
        ("client_id", client_id),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("redirect_uri", redirect_uri),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", state),
    ];
    let query = q
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{AUTH_HOST}/o/oauth2/v2/auth?{query}")
}

pub async fn exchange_code(
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<GDriveTokens, String> {
    let form = [
        ("code", code),
        ("client_id", client_id),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{TOKEN_HOST}/token"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Google token exchange 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Google token HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
    }
    let parsed: TokenResp = serde_json::from_str(&text)
        .map_err(|e| format!("Google token 响应解析失败：{e}"))?;
    let refresh = parsed.refresh_token.ok_or_else(|| {
        "Google 未返回 refresh_token：请确保 access_type=offline 且首次授权（必要时撤销后重授）".to_string()
    })?;
    let expires_at = now_epoch() + parsed.expires_in;
    let mut tokens = GDriveTokens {
        access_token: parsed.access_token,
        refresh_token: refresh,
        expires_at,
        display: String::new(),
    };
    if let Ok(email) = userinfo_email(&tokens).await {
        tokens.display = email;
    }
    Ok(tokens)
}

async fn refresh_tokens(tokens: &mut GDriveTokens, client_id: &str) -> Result<(), String> {
    let form = [
        ("client_id", client_id),
        ("refresh_token", tokens.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{TOKEN_HOST}/token");
    let text = crate::oauth::http_post_form_with_retry(
        &client,
        &url,
        form.as_slice(),
        "Google refresh",
    )
    .await?;
    #[derive(Deserialize)]
    struct R {
        access_token: String,
        expires_in: u64,
    }
    let parsed: R = serde_json::from_str(&text)
        .map_err(|e| format!("Google refresh 解析失败：{e}"))?;
    tokens.access_token = parsed.access_token;
    tokens.expires_at = now_epoch() + parsed.expires_in;
    Ok(())
}

pub async fn ensure_fresh(tokens: &mut GDriveTokens, client_id: &str) -> Result<(), String> {
    if tokens.expires_at > now_epoch() + 60 {
        return Ok(());
    }
    refresh_tokens(tokens, client_id).await
}

pub async fn userinfo_email(tokens: &GDriveTokens) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{API_HOST}/oauth2/v2/userinfo"))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("Google userinfo 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct U {
        email: Option<String>,
        name: Option<String>,
    }
    let u: U = serde_json::from_str(&text).map_err(|e| format!("userinfo 解析失败：{e}"))?;
    match (u.name, u.email) {
        (Some(n), Some(e)) => Ok(format!("{n} ({e})")),
        (None, Some(e)) => Ok(e),
        (Some(n), None) => Ok(n),
        _ => Ok("(unknown)".to_string()),
    }
}

pub async fn list_files(
    tokens: &GDriveTokens,
    q: &str,
    page_token: Option<&str>,
) -> Result<GDriveList, String> {
    let mut params: Vec<(String, String)> = vec![
        ("pageSize".to_string(), "200".to_string()),
        (
            "fields".to_string(),
            "nextPageToken,files(id,name,mimeType,size,modifiedTime)".to_string(),
        ),
        ("spaces".to_string(), "drive".to_string()),
    ];
    if !q.is_empty() {
        params.push(("q".to_string(), q.to_string()));
    }
    if let Some(token) = page_token {
        if !token.is_empty() {
            params.push(("pageToken".to_string(), token.to_string()));
        }
    }
    let qs = params
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding(k), urlencoding(v)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("{API_HOST}/drive/v3/files?{qs}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("Google Drive list 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Google Drive list HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct RawFile {
        id: String,
        name: String,
        #[serde(default, rename = "mimeType")]
        mime_type: String,
        #[serde(default)]
        size: Option<String>,
        #[serde(default, rename = "modifiedTime")]
        modified_time: String,
    }
    #[derive(Deserialize)]
    struct R {
        #[serde(default, rename = "nextPageToken")]
        next_page_token: Option<String>,
        #[serde(default)]
        files: Vec<RawFile>,
    }
    let parsed: R = serde_json::from_str(&text).map_err(|e| format!("Drive list 解析失败：{e}"))?;
    Ok(GDriveList {
        next_page_token: parsed.next_page_token,
        files: parsed
            .files
            .into_iter()
            .map(|f| GDriveFile {
                id: f.id,
                name: f.name,
                mime_type: f.mime_type,
                size: f.size.and_then(|s| s.parse().ok()).unwrap_or(0),
                modified_time: f.modified_time,
            })
            .collect(),
    })
}

/// 上传文件（multipart 简单实现）。如果给定 existing_id 则覆盖更新，否则新建。
pub async fn upload(
    tokens: &GDriveTokens,
    existing_id: Option<&str>,
    name: &str,
    parent_id: Option<&str>,
    bytes: Vec<u8>,
    mime_type: &str,
) -> Result<String, String> {
    if bytes.len() > MAX_GDRIVE_OBJECT {
        return Err(format!(
            "Google Drive 单对象上传超过上限：{} > {}",
            bytes.len(),
            MAX_GDRIVE_OBJECT
        ));
    }
    let mut meta = serde_json::Map::new();
    meta.insert("name".to_string(), serde_json::Value::String(name.to_string()));
    if existing_id.is_none() {
        if let Some(pid) = parent_id {
            if !pid.is_empty() {
                meta.insert(
                    "parents".to_string(),
                    serde_json::Value::Array(vec![serde_json::Value::String(pid.to_string())]),
                );
            }
        }
    }
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let boundary = "----markioGdriveBoundary7d8e3a5f";
    let mut body: Vec<u8> = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(meta_json.as_bytes());
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(format!("Content-Type: {mime_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let (url, is_update) = match existing_id {
        Some(id) => (
            format!("{API_HOST}/upload/drive/v3/files/{id}?uploadType=multipart"),
            true,
        ),
        None => (
            format!("{API_HOST}/upload/drive/v3/files?uploadType=multipart"),
            false,
        ),
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let req = if is_update { client.patch(&url) } else { client.post(&url) };
    let resp = req
        .bearer_auth(&tokens.access_token)
        .header(
            "Content-Type",
            format!("multipart/related; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Drive upload 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Drive upload HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct R {
        id: String,
    }
    let parsed: R = serde_json::from_str(&text).map_err(|e| format!("Drive upload 解析失败：{e}"))?;
    Ok(parsed.id)
}

pub async fn download(tokens: &GDriveTokens, file_id: &str) -> Result<Vec<u8>, String> {
    let url = format!("{API_HOST}/drive/v3/files/{file_id}?alt=media");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("Drive download 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Drive download HTTP {status}: {text}"));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Drive download 读 body 失败：{e}"))?;
    if bytes.len() > MAX_GDRIVE_OBJECT {
        return Err(format!(
            "Google Drive 单对象下载超过上限：{} > {}",
            bytes.len(),
            MAX_GDRIVE_OBJECT
        ));
    }
    Ok(bytes.to_vec())
}

pub async fn delete(tokens: &GDriveTokens, file_id: &str) -> Result<(), String> {
    let url = format!("{API_HOST}/drive/v3/files/{file_id}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .delete(&url)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("Drive delete 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 404 {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Drive delete HTTP {status}: {text}"));
    }
    Ok(())
}
