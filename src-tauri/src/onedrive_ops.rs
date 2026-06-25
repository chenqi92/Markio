// OneDrive 集成：Microsoft identity platform OAuth2 PKCE + Microsoft Graph drive API。
//
// 用 /common 租户同时支持个人 + 工作/学校账号；公共客户端（移动和桌面应用程序）
// 走 PKCE，无需 client_secret。token / refresh_token 存 OS 钥匙串。
//
// 路径寻址：drive 根下的相对路径（'/' 分隔，无前导斜杠），空串=根。
// Graph URL 形如 /me/drive/root:/{encoded path}:/children ；根用 /me/drive/root/children。
//
// 文档：
//   - OAuth: https://learn.microsoft.com/azure/active-directory/develop/v2-oauth2-auth-code-flow
//   - Graph drive: https://learn.microsoft.com/graph/api/resources/driveitem

use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_ONEDRIVE_OBJECT: usize = 50 * 1024 * 1024;
/// 简单 PUT 上限；超过走 createUploadSession 分片
const SIMPLE_UPLOAD_MAX: usize = 4 * 1024 * 1024;
/// 分片大小，必须是 320 KiB 的整数倍
const UPLOAD_CHUNK: usize = 320 * 1024 * 10; // 3.2 MiB

const AUTH_HOST: &str = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const SCOPE: &str = "Files.ReadWrite offline_access User.Read";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OneDriveTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveStatus {
    pub connected: bool,
    pub display: String,
    pub expires_in_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveEntry {
    pub tag: String, // "file" | "folder"
    pub name: String,
    /// drive 根下的完整相对路径（'/' 分隔，无前导斜杠）
    pub path: String,
    pub size: u64,
    pub last_modified: String,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveList {
    pub entries: Vec<OneDriveEntry>,
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

/// 把相对路径按段做 percent-encoding，保留斜杠分隔（Graph root:/{path}: 语法用）。
fn encode_path(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.is_empty())
        .map(urlencoding)
        .collect::<Vec<_>>()
        .join("/")
}

/// 构造某相对路径上的 Graph driveItem URL 前缀。
/// 空路径 → /me/drive/root{suffix_for_root}；非空 → /me/drive/root:/{enc}:{suffix}
fn item_url(path: &str, root_suffix: &str, path_suffix: &str) -> String {
    let enc = encode_path(path);
    if enc.is_empty() {
        format!("{GRAPH}/me/drive/root{root_suffix}")
    } else {
        format!("{GRAPH}/me/drive/root:/{enc}:{path_suffix}")
    }
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
        ("redirect_uri", redirect_uri),
        ("response_mode", "query"),
        ("scope", SCOPE),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("prompt", "select_account"),
    ];
    let query = q
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{AUTH_HOST}/authorize?{query}")
}

pub async fn exchange_code(
    client_id: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<OneDriveTokens, String> {
    let form = [
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
        ("scope", SCOPE),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{AUTH_HOST}/token"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("OneDrive token exchange 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("OneDrive token HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
    }
    let parsed: TokenResp =
        serde_json::from_str(&text).map_err(|e| format!("OneDrive token 响应解析失败：{e}"))?;
    let refresh = parsed.refresh_token.ok_or_else(|| {
        "OneDrive 未返回 refresh_token：请确认 scope 含 offline_access".to_string()
    })?;
    let expires_at = now_epoch() + parsed.expires_in;
    let mut tokens = OneDriveTokens {
        access_token: parsed.access_token,
        refresh_token: refresh,
        expires_at,
        display: String::new(),
    };
    if let Ok(name) = me_display(&tokens).await {
        tokens.display = name;
    }
    Ok(tokens)
}

async fn refresh_tokens(tokens: &mut OneDriveTokens, client_id: &str) -> Result<(), String> {
    let form = [
        ("client_id", client_id),
        ("refresh_token", tokens.refresh_token.as_str()),
        ("grant_type", "refresh_token"),
        ("scope", SCOPE),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{AUTH_HOST}/token");
    let text =
        crate::oauth::http_post_form_with_retry(&client, &url, form.as_slice(), "OneDrive refresh")
            .await?;
    #[derive(Deserialize)]
    struct R {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
    }
    let parsed: R =
        serde_json::from_str(&text).map_err(|e| format!("OneDrive refresh 解析失败：{e}"))?;
    tokens.access_token = parsed.access_token;
    // 微软会轮换 refresh_token；返回新的就更新
    if let Some(rt) = parsed.refresh_token {
        if !rt.is_empty() {
            tokens.refresh_token = rt;
        }
    }
    tokens.expires_at = now_epoch() + parsed.expires_in;
    Ok(())
}

/// access_token 剩余 < 60s 就刷新；返回 true 表示 token 有更新需要回写钥匙串。
pub async fn ensure_fresh(tokens: &mut OneDriveTokens, client_id: &str) -> Result<bool, String> {
    if tokens.expires_at > now_epoch() + 60 {
        return Ok(false);
    }
    refresh_tokens(tokens, client_id).await?;
    Ok(true)
}

pub async fn me_display(tokens: &OneDriveTokens) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("{GRAPH}/me"))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("OneDrive /me 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct Me {
        #[serde(rename = "displayName")]
        display_name: Option<String>,
        #[serde(rename = "userPrincipalName")]
        upn: Option<String>,
        mail: Option<String>,
    }
    let me: Me = serde_json::from_str(&text).map_err(|e| format!("/me 解析失败：{e}"))?;
    let email = me.mail.or(me.upn);
    Ok(match (me.display_name, email) {
        (Some(n), Some(e)) => format!("{n} ({e})"),
        (None, Some(e)) => e,
        (Some(n), None) => n,
        _ => "(unknown)".to_string(),
    })
}

#[derive(Deserialize)]
struct RawItem {
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(rename = "lastModifiedDateTime", default)]
    last_modified: String,
    #[serde(rename = "eTag", default)]
    etag: String,
    #[serde(default)]
    folder: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawChildren {
    value: Vec<RawItem>,
    #[serde(rename = "@odata.nextLink", default)]
    next_link: Option<String>,
}

/// 列出某相对路径目录下的直接子项（非递归）；自动跟随分页 nextLink。
pub async fn list(tokens: &OneDriveTokens, path: &str) -> Result<OneDriveList, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let base = item_url(path, "/children", "/children");
    let mut url = format!(
        "{base}?$top=200&$select=name,size,lastModifiedDateTime,eTag,folder,file"
    );
    let mut entries = Vec::new();
    let prefix = path.trim_matches('/');
    loop {
        let resp = client
            .get(&url)
            .bearer_auth(&tokens.access_token)
            .send()
            .await
            .map_err(|e| format!("OneDrive list 失败：{e}"))?;
        let status = resp.status();
        // 目录还不存在（首次同步远端根 / 子目录未建）视为空列表，不报错。
        if status.as_u16() == 404 {
            return Ok(OneDriveList { entries });
        }
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("OneDrive list HTTP {status}: {text}"));
        }
        let parsed: RawChildren =
            serde_json::from_str(&text).map_err(|e| format!("OneDrive list 解析失败：{e}"))?;
        for it in parsed.value {
            let is_dir = it.folder.is_some();
            let full = if prefix.is_empty() {
                it.name.clone()
            } else {
                format!("{prefix}/{}", it.name)
            };
            entries.push(OneDriveEntry {
                tag: if is_dir { "folder" } else { "file" }.to_string(),
                name: it.name,
                path: full,
                size: it.size,
                last_modified: it.last_modified,
                etag: it.etag,
            });
        }
        match parsed.next_link {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(OneDriveList { entries })
}

pub async fn download(tokens: &OneDriveTokens, path: &str) -> Result<Vec<u8>, String> {
    if path.trim_matches('/').is_empty() {
        return Err("OneDrive download 路径为空".to_string());
    }
    let url = item_url(path, "/content", "/content");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("OneDrive download 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("OneDrive download HTTP {status}: {text}"));
    }
    crate::read_capped(resp, MAX_ONEDRIVE_OBJECT, "OneDrive").await
}

pub async fn upload(tokens: &OneDriveTokens, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    if path.trim_matches('/').is_empty() {
        return Err("OneDrive upload 路径为空".to_string());
    }
    if bytes.len() > MAX_ONEDRIVE_OBJECT {
        return Err(format!(
            "OneDrive 单对象上传超过上限：{} > {}",
            bytes.len(),
            MAX_ONEDRIVE_OBJECT
        ));
    }
    if bytes.len() <= SIMPLE_UPLOAD_MAX {
        upload_simple(tokens, path, bytes).await
    } else {
        upload_session(tokens, path, bytes).await
    }
}

async fn upload_simple(tokens: &OneDriveTokens, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    let url = item_url(path, "/content", "/content");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .put(&url)
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("OneDrive upload 失败：{e}"))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    Err(format!("OneDrive upload HTTP {status}: {text}"))
}

async fn upload_session(tokens: &OneDriveTokens, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    let create_url = item_url(path, "/createUploadSession", "/createUploadSession");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "item": { "@microsoft.graph.conflictBehavior": "replace" }
    });
    let resp = client
        .post(&create_url)
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("OneDrive createUploadSession 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("OneDrive createUploadSession HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct Session {
        #[serde(rename = "uploadUrl")]
        upload_url: String,
    }
    let session: Session =
        serde_json::from_str(&text).map_err(|e| format!("uploadSession 解析失败：{e}"))?;

    let total = bytes.len();
    let mut start = 0usize;
    while start < total {
        let end = std::cmp::min(start + UPLOAD_CHUNK, total);
        let chunk = bytes[start..end].to_vec();
        let range = format!("bytes {}-{}/{}", start, end - 1, total);
        // uploadUrl 自带鉴权，不需要 bearer
        let resp = client
            .put(&session.upload_url)
            .header("Content-Length", chunk.len().to_string())
            .header("Content-Range", range)
            .body(chunk)
            .send()
            .await
            .map_err(|e| format!("OneDrive 分片上传失败：{e}"))?;
        let st = resp.status();
        if !(st.is_success() || st.as_u16() == 202) {
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("OneDrive 分片上传 HTTP {st}: {t}"));
        }
        start = end;
    }
    Ok(())
}

pub async fn create_folder(tokens: &OneDriveTokens, path: &str) -> Result<(), String> {
    let path = path.trim_matches('/');
    if path.is_empty() {
        return Ok(());
    }
    let (parent, name) = match path.rsplit_once('/') {
        Some((p, n)) => (p, n),
        None => ("", path),
    };
    let url = item_url(parent, "/children", "/children");
    let body = serde_json::json!({
        "name": name,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail",
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .bearer_auth(&tokens.access_token)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("OneDrive create_folder 失败：{e}"))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    // 409 nameAlreadyExists 视为已存在（幂等）
    if status.as_u16() == 409 {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    Err(format!("OneDrive create_folder HTTP {status}: {text}"))
}

pub async fn delete(tokens: &OneDriveTokens, path: &str) -> Result<(), String> {
    if path.trim_matches('/').is_empty() {
        return Err("OneDrive delete 路径为空".to_string());
    }
    let url = item_url(path, "", "");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .delete(&url)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("OneDrive delete 失败：{e}"))?;
    let status = resp.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    Err(format!("OneDrive delete HTTP {status}: {text}"))
}
