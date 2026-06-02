// Dropbox 集成：OAuth2 PKCE 授权 + Files API（list/upload/download/delete）。
//
// 由于 Dropbox 要求每个 App 在开发者后台注册并拿 client_id（app key），
// 这里把 client_id 作为运行时参数传入，不硬编码。token / refresh_token
// 存到 OS 钥匙串 (secrets.rs)。
//
// 文档：https://www.dropbox.com/developers/documentation/http/documentation

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_DROPBOX_OBJECT: usize = 50 * 1024 * 1024;

const AUTH_HOST: &str = "https://www.dropbox.com";
const API_HOST: &str = "https://api.dropboxapi.com";
const CONTENT_HOST: &str = "https://content.dropboxapi.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropboxTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// epoch seconds when access_token will expire
    pub expires_at: u64,
    pub account_id: String,
    /// 显示名（例如 "张三 (zhangsan@example.com)"）
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropboxStatus {
    pub connected: bool,
    pub display: String,
    pub account_id: String,
    pub expires_in_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropboxEntry {
    pub tag: String, // "file" | "folder" | "deleted"
    pub name: String,
    pub path_lower: String,
    pub path_display: String,
    pub size: u64,
    pub server_modified: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropboxList {
    pub entries: Vec<DropboxEntry>,
    pub has_more: bool,
    pub cursor: Option<String>,
}

#[derive(Deserialize)]
struct RawDropboxEntry {
    #[serde(rename = ".tag")]
    tag: String,
    name: String,
    #[serde(default)]
    path_lower: String,
    #[serde(default)]
    path_display: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    server_modified: String,
}

#[derive(Deserialize)]
struct RawDropboxList {
    entries: Vec<RawDropboxEntry>,
    has_more: bool,
    cursor: String,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("redirect_uri", redirect_uri),
        ("token_access_type", "offline"),
        ("state", state),
    ];
    let query = q
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{AUTH_HOST}/oauth2/authorize?{query}")
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

pub async fn exchange_code(
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<DropboxTokens, String> {
    let form = [
        ("code", code),
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{API_HOST}/oauth2/token"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Dropbox token exchange 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Dropbox token HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
        account_id: Option<String>,
    }
    let parsed: TokenResp = serde_json::from_str(&text)
        .map_err(|e| format!("Dropbox token 响应解析失败：{e}; body={text}"))?;
    let refresh = parsed.refresh_token.ok_or_else(|| {
        "Dropbox 未返回 refresh_token，请确认 token_access_type=offline".to_string()
    })?;
    let expires_at = now_epoch() + parsed.expires_in;
    let account_id = parsed.account_id.unwrap_or_default();

    // 获取账户显示名
    let mut tokens = DropboxTokens {
        access_token: parsed.access_token,
        refresh_token: refresh,
        expires_at,
        account_id,
        display: String::new(),
    };
    if let Ok(info) = get_current_account(&tokens).await {
        tokens.display = info;
    }
    Ok(tokens)
}

async fn refresh_tokens(tokens: &mut DropboxTokens, client_id: &str) -> Result<(), String> {
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", tokens.refresh_token.as_str()),
        ("client_id", client_id),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    // 桌面端弱网常见：酒店 WiFi 抖一下、DNS 暂时无解。网络错误 / 5xx 用指数退避重试，
    // 4xx（多半是 invalid_grant：refresh_token 真的失效）直接失败让用户重 OAuth。
    let url = format!("{API_HOST}/oauth2/token");
    let text =
        crate::oauth::http_post_form_with_retry(&client, &url, form.as_slice(), "Dropbox refresh")
            .await?;
    #[derive(Deserialize)]
    struct R {
        access_token: String,
        expires_in: u64,
    }
    let parsed: R =
        serde_json::from_str(&text).map_err(|e| format!("Dropbox refresh 响应解析失败：{e}"))?;
    tokens.access_token = parsed.access_token;
    tokens.expires_at = now_epoch() + parsed.expires_in;
    Ok(())
}

/// 如果 access_token 快过期了（剩余 < 60s）就刷一次。
pub async fn ensure_fresh(tokens: &mut DropboxTokens, client_id: &str) -> Result<(), String> {
    if tokens.expires_at > now_epoch() + 60 {
        return Ok(());
    }
    refresh_tokens(tokens, client_id).await
}

pub async fn get_current_account(tokens: &DropboxTokens) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{API_HOST}/2/users/get_current_account"))
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body("null")
        .send()
        .await
        .map_err(|e| format!("Dropbox get_current_account 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct AcctName {
        display_name: String,
    }
    #[derive(Deserialize)]
    struct Acct {
        name: AcctName,
        email: String,
    }
    let parsed: Acct =
        serde_json::from_str(&text).map_err(|e| format!("Dropbox account 解析失败：{e}"))?;
    Ok(format!("{} ({})", parsed.name.display_name, parsed.email))
}

pub async fn list_folder(tokens: &DropboxTokens, path: &str) -> Result<DropboxList, String> {
    let path_arg = if path == "/" { "" } else { path };
    let body = serde_json::json!({
        "path": path_arg,
        "recursive": false,
        "include_deleted": false,
        "limit": 200,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{API_HOST}/2/files/list_folder"))
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Dropbox list_folder 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Dropbox list HTTP {status}: {text}"));
    }
    let parsed: RawDropboxList =
        serde_json::from_str(&text).map_err(|e| format!("Dropbox list 响应解析失败：{e}"))?;
    Ok(dropbox_list_from_raw(parsed))
}

pub async fn list_folder_continue(
    tokens: &DropboxTokens,
    cursor: &str,
) -> Result<DropboxList, String> {
    let body = serde_json::json!({ "cursor": cursor });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{API_HOST}/2/files/list_folder/continue"))
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Dropbox list_folder/continue 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Dropbox list/continue HTTP {status}: {text}"));
    }
    let parsed: RawDropboxList = serde_json::from_str(&text)
        .map_err(|e| format!("Dropbox list/continue 响应解析失败：{e}"))?;
    Ok(dropbox_list_from_raw(parsed))
}

fn dropbox_list_from_raw(parsed: RawDropboxList) -> DropboxList {
    DropboxList {
        entries: parsed
            .entries
            .into_iter()
            .map(|e| DropboxEntry {
                tag: e.tag,
                name: e.name,
                path_lower: e.path_lower,
                path_display: e.path_display,
                size: e.size,
                server_modified: e.server_modified,
            })
            .collect(),
        has_more: parsed.has_more,
        cursor: Some(parsed.cursor),
    }
}

pub async fn upload(tokens: &DropboxTokens, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > MAX_DROPBOX_OBJECT {
        return Err(format!(
            "Dropbox 单对象上传超过上限：{} > {}",
            bytes.len(),
            MAX_DROPBOX_OBJECT
        ));
    }
    let arg = serde_json::json!({
        "path": path,
        "mode": "overwrite",
        "autorename": false,
        "mute": true,
    })
    .to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{CONTENT_HOST}/2/files/upload"))
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/octet-stream")
        .header("Dropbox-API-Arg", arg)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Dropbox upload 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Dropbox upload HTTP {status}: {text}"));
    }
    Ok(())
}

pub async fn create_folder(tokens: &DropboxTokens, path: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "path": path,
        "autorename": false,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{API_HOST}/2/files/create_folder_v2"))
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Dropbox create_folder 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(());
    }
    // 409 既可能是"目录已存在"（可视为成功），也可能是父路径不存在 / 权限不足等真错误。
    // 只有 error_summary 指向 path/conflict 才当作已存在，其余 409 一律上报。
    if status.as_u16() == 409 && dropbox_error_summary(&text).contains("path/conflict") {
        return Ok(());
    }
    Err(format!("Dropbox create_folder HTTP {status}: {text}"))
}

/// 从 Dropbox 错误响应里取 error_summary（形如 "path/conflict/folder/."）。解析失败返回空串。
fn dropbox_error_summary(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error_summary").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_default()
}

pub async fn download(tokens: &DropboxTokens, path: &str) -> Result<Vec<u8>, String> {
    let arg = serde_json::json!({ "path": path }).to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{CONTENT_HOST}/2/files/download"))
        .bearer_auth(&tokens.access_token)
        .header("Dropbox-API-Arg", arg)
        .send()
        .await
        .map_err(|e| format!("Dropbox download 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Dropbox download HTTP {status}: {text}"));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Dropbox download 读 body 失败：{e}"))?;
    if bytes.len() > MAX_DROPBOX_OBJECT {
        return Err(format!(
            "Dropbox 单对象下载超过上限：{} > {}",
            bytes.len(),
            MAX_DROPBOX_OBJECT
        ));
    }
    Ok(bytes.to_vec())
}

pub async fn delete(tokens: &DropboxTokens, path: &str) -> Result<(), String> {
    let body = serde_json::json!({ "path": path });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{API_HOST}/2/files/delete_v2"))
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Dropbox delete 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(());
    }
    // 409 仅当 error_summary 指向 not_found 才视为"已删除"，权限不足等其它 409 上报。
    if status.as_u16() == 409 && dropbox_error_summary(&text).contains("not_found") {
        return Ok(());
    }
    Err(format!("Dropbox delete HTTP {status}: {text}"))
}
