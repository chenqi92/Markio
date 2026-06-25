// 百度网盘集成：OAuth2 设备码授权（无需回调基础设施）+ xpan 文件 API。
//
// 设备码流程：device/code 拿 user_code + 验证地址 → 用户在浏览器授权 → 轮询 token。
// 上传走 precreate → superfile2 分片 → create 三段式，每 4MB 块算 MD5。
// 写权限受限：未过审应用通常只能写入自己的应用目录 /apps/<应用名>/，remoteRoot 应设在该目录下。
//
// client_id(AppKey) / client_secret(SecretKey) 由编译期内置（builtin_credentials）。
//
// 文档：https://pan.baidu.com/union/doc

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MAX_BAIDU_OBJECT: usize = 50 * 1024 * 1024;
/// 百度分片固定 4MB
const BLOCK: usize = 4 * 1024 * 1024;

const OAUTH: &str = "https://openapi.baidu.com/oauth/2.0";
const PAN: &str = "https://pan.baidu.com/rest/2.0/xpan";
const PCS: &str = "https://d.pcs.baidu.com/rest/2.0/pcs";
const SCOPE: &str = "basic,netdisk";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaiduTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    pub display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduStatus {
    pub connected: bool,
    pub display: String,
    pub expires_in_secs: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub qrcode_url: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduEntry {
    /// fs_id 是 u64、可超过 2^53，用字符串传给前端避免精度丢失
    pub fs_id: String,
    pub name: String,
    /// netdisk 绝对路径
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    /// 文件内容 md5（百度返回；目录为空）
    pub md5: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduList {
    pub entries: Vec<BaiduEntry>,
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

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn block_md5s(bytes: &[u8]) -> Vec<String> {
    if bytes.is_empty() {
        // 空文件也要一个块的 md5
        let mut h = Md5::new();
        h.update([]);
        return vec![hex::encode(h.finalize())];
    }
    bytes
        .chunks(BLOCK)
        .map(|c| {
            let mut h = Md5::new();
            h.update(c);
            hex::encode(h.finalize())
        })
        .collect()
}

// ─── OAuth 设备码 ───────────────────────────────────────────────

pub async fn device_code(client_id: &str) -> Result<BaiduDeviceCode, String> {
    let url = format!(
        "{OAUTH}/device/code?response_type=device_code&client_id={}&scope={}",
        urlencoding(client_id),
        urlencoding(SCOPE),
    );
    let resp = http()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("百度 device/code 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct R {
        device_code: Option<String>,
        user_code: Option<String>,
        verification_url: Option<String>,
        qrcode_url: Option<String>,
        interval: Option<u64>,
        expires_in: Option<u64>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let r: R = serde_json::from_str(&text).map_err(|e| format!("百度 device/code 解析失败：{e}"))?;
    if let Some(err) = r.error {
        return Err(format!("百度授权初始化失败：{err} {}", r.error_description.unwrap_or_default()));
    }
    Ok(BaiduDeviceCode {
        device_code: r.device_code.ok_or("百度未返回 device_code")?,
        user_code: r.user_code.unwrap_or_default(),
        verification_url: r.verification_url.unwrap_or_else(|| "https://openapi.baidu.com/device".to_string()),
        qrcode_url: r.qrcode_url.unwrap_or_default(),
        interval: r.interval.unwrap_or(5),
        expires_in: r.expires_in.unwrap_or(300),
    })
}

/// 轮询一次设备码 token。返回 Ok(Some(tokens)) 表示授权完成；Ok(None) 表示仍在等待用户授权。
pub async fn device_poll(
    client_id: &str,
    client_secret: &str,
    device_code: &str,
) -> Result<Option<BaiduTokens>, String> {
    let url = format!(
        "{OAUTH}/token?grant_type=device_token&code={}&client_id={}&client_secret={}",
        urlencoding(device_code),
        urlencoding(client_id),
        urlencoding(client_secret),
    );
    let resp = http()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("百度 token 轮询失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct R {
        access_token: Option<String>,
        refresh_token: Option<String>,
        expires_in: Option<u64>,
        error: Option<String>,
    }
    let r: R = serde_json::from_str(&text).map_err(|e| format!("百度 token 解析失败：{e}"))?;
    if let Some(err) = r.error {
        // 仍在等待用户授权
        if err == "authorization_pending" || err == "slow_down" {
            return Ok(None);
        }
        return Err(format!("百度授权失败：{err}"));
    }
    let access_token = r.access_token.ok_or("百度未返回 access_token")?;
    let refresh_token = r.refresh_token.unwrap_or_default();
    let mut tokens = BaiduTokens {
        access_token,
        refresh_token,
        expires_at: now_epoch() + r.expires_in.unwrap_or(2592000),
        display: String::new(),
    };
    if let Ok(name) = uinfo(&tokens).await {
        tokens.display = name;
    }
    Ok(Some(tokens))
}

async fn refresh(tokens: &mut BaiduTokens, client_id: &str, client_secret: &str) -> Result<(), String> {
    if tokens.refresh_token.is_empty() {
        return Err("百度 refresh_token 缺失，请重新授权".to_string());
    }
    let url = format!(
        "{OAUTH}/token?grant_type=refresh_token&refresh_token={}&client_id={}&client_secret={}",
        urlencoding(&tokens.refresh_token),
        urlencoding(client_id),
        urlencoding(client_secret),
    );
    let resp = http()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("百度刷新失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct R {
        access_token: Option<String>,
        refresh_token: Option<String>,
        expires_in: Option<u64>,
        error: Option<String>,
    }
    let r: R = serde_json::from_str(&text).map_err(|e| format!("百度刷新解析失败：{e}"))?;
    if let Some(err) = r.error {
        return Err(format!("百度刷新失败：{err}"));
    }
    tokens.access_token = r.access_token.ok_or("百度刷新未返回 access_token")?;
    if let Some(rt) = r.refresh_token {
        if !rt.is_empty() {
            tokens.refresh_token = rt;
        }
    }
    tokens.expires_at = now_epoch() + r.expires_in.unwrap_or(2592000);
    Ok(())
}

pub async fn ensure_fresh(
    tokens: &mut BaiduTokens,
    client_id: &str,
    client_secret: &str,
) -> Result<bool, String> {
    if tokens.expires_at > now_epoch() + 60 {
        return Ok(false);
    }
    refresh(tokens, client_id, client_secret).await?;
    Ok(true)
}

pub async fn uinfo(tokens: &BaiduTokens) -> Result<String, String> {
    let url = format!(
        "{PAN}/nas?method=uinfo&access_token={}",
        urlencoding(&tokens.access_token)
    );
    let resp = http()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("百度 uinfo 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    #[derive(Deserialize)]
    struct R {
        baidu_name: Option<String>,
        netdisk_name: Option<String>,
    }
    let r: R = serde_json::from_str(&text).map_err(|e| format!("百度 uinfo 解析失败：{e}"))?;
    Ok(r.baidu_name.or(r.netdisk_name).unwrap_or_else(|| "百度网盘用户".to_string()))
}

// ─── 文件 API ───────────────────────────────────────────────────

fn check_errno(text: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("百度响应解析失败：{e}; body={text}"))?;
    let errno = v.get("errno").and_then(|e| e.as_i64()).unwrap_or(0);
    if errno != 0 {
        return Err(format!("百度 API errno {errno}"));
    }
    Ok(v)
}

pub async fn list(tokens: &BaiduTokens, dir: &str) -> Result<BaiduList, String> {
    let mut entries = Vec::new();
    let mut start = 0u64;
    loop {
        let url = format!(
            "{PAN}/file?method=list&dir={}&order=name&start={}&limit=1000&access_token={}",
            urlencoding(dir),
            start,
            urlencoding(&tokens.access_token),
        );
        let resp = http()?
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("百度 list 失败：{e}"))?;
        let text = resp.text().await.unwrap_or_default();
        let v = match check_errno(&text) {
            Ok(v) => v,
            // -9 = 文件不存在（首次同步根目录还没建）→ 空列表
            Err(e) if e.contains("errno -9") => return Ok(BaiduList { entries }),
            Err(e) => return Err(e),
        };
        let arr = v.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
        let got = arr.len();
        for f in arr {
            let is_dir = f.get("isdir").and_then(|d| d.as_i64()).unwrap_or(0) == 1;
            entries.push(BaiduEntry {
                fs_id: f.get("fs_id").and_then(|x| x.as_u64()).unwrap_or(0).to_string(),
                name: f.get("server_filename").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                path: f.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                is_dir,
                size: f.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
                mtime: f.get("server_mtime").and_then(|x| x.as_i64()).unwrap_or(0),
                md5: f.get("md5").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
        start += got as u64;
        if got < 1000 {
            break;
        }
    }
    Ok(BaiduList { entries })
}

pub async fn download(tokens: &BaiduTokens, fs_id: &str) -> Result<Vec<u8>, String> {
    if fs_id.is_empty() || !fs_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("百度 fs_id 无效".to_string());
    }
    // 1) 取 dlink
    let meta_url = format!(
        "{PAN}/multimedia?method=filemetas&fsids=%5B{}%5D&dlink=1&access_token={}",
        fs_id,
        urlencoding(&tokens.access_token),
    );
    let resp = http()?
        .get(&meta_url)
        .send()
        .await
        .map_err(|e| format!("百度 filemetas 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    let v = check_errno(&text)?;
    let dlink = v
        .get("list")
        .and_then(|l| l.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("dlink"))
        .and_then(|d| d.as_str())
        .ok_or("百度未返回 dlink")?
        .to_string();
    // 2) 下载（dlink 要带 access_token，且 UA 必须含 pan.baidu.com，否则 403）
    let dl = format!("{dlink}&access_token={}", urlencoding(&tokens.access_token));
    let resp = http()?
        .get(&dl)
        .header("User-Agent", "pan.baidu.com")
        .send()
        .await
        .map_err(|e| format!("百度 download 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("百度 download HTTP {status}: {t}"));
    }
    crate::read_capped(resp, MAX_BAIDU_OBJECT, "百度网盘").await
}

pub async fn upload(tokens: &BaiduTokens, path: &str, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > MAX_BAIDU_OBJECT {
        return Err(format!("百度单文件上传超过上限：{} > {}", bytes.len(), MAX_BAIDU_OBJECT));
    }
    let size = bytes.len();
    let blocks = block_md5s(&bytes);
    let block_list = serde_json::to_string(&blocks).map_err(|e| e.to_string())?;
    let client = http()?;

    // 1) precreate
    let pre_url = format!("{PAN}/file?method=precreate&access_token={}", urlencoding(&tokens.access_token));
    let pre_form = [
        ("path", path),
        ("size", &size.to_string()),
        ("isdir", "0"),
        ("autoinit", "1"),
        ("rtype", "3"),
        ("block_list", &block_list),
    ];
    let resp = client
        .post(&pre_url)
        .form(&pre_form)
        .send()
        .await
        .map_err(|e| format!("百度 precreate 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    let v = check_errno(&text)?;
    let uploadid = v.get("uploadid").and_then(|u| u.as_str()).ok_or("百度未返回 uploadid")?.to_string();

    // 2) superfile2 分片上传
    let chunks: Vec<&[u8]> = if bytes.is_empty() { vec![&[]] } else { bytes.chunks(BLOCK).collect() };
    for (seq, chunk) in chunks.iter().enumerate() {
        let up_url = format!(
            "{PCS}/superfile2?method=upload&access_token={}&type=tmpfile&path={}&uploadid={}&partseq={}",
            urlencoding(&tokens.access_token),
            urlencoding(path),
            urlencoding(&uploadid),
            seq,
        );
        let part = reqwest::multipart::Part::bytes(chunk.to_vec())
            .file_name("file")
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let resp = client
            .post(&up_url)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("百度分片上传失败：{e}"))?;
        let t = resp.text().await.unwrap_or_default();
        // superfile2 成功返回 {"md5":...}，失败返回 errno
        if t.contains("\"errno\"") {
            check_errno(&t)?;
        }
    }

    // 3) create
    let create_url = format!("{PAN}/file?method=create&access_token={}", urlencoding(&tokens.access_token));
    let create_form = [
        ("path", path),
        ("size", &size.to_string()),
        ("isdir", "0"),
        ("uploadid", &uploadid),
        ("block_list", &block_list),
        ("rtype", "3"),
    ];
    let resp = client
        .post(&create_url)
        .form(&create_form)
        .send()
        .await
        .map_err(|e| format!("百度 create 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    check_errno(&text)?;
    Ok(())
}

pub async fn create_folder(tokens: &BaiduTokens, path: &str) -> Result<(), String> {
    let url = format!("{PAN}/file?method=create&access_token={}", urlencoding(&tokens.access_token));
    let form = [("path", path), ("isdir", "1"), ("rtype", "0")];
    let resp = http()?
        .post(&url)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("百度 create_folder 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    match check_errno(&text) {
        Ok(_) => Ok(()),
        // -8 = 文件已存在 → 幂等成功
        Err(e) if e.contains("errno -8") => Ok(()),
        Err(e) => Err(e),
    }
}

pub async fn delete(tokens: &BaiduTokens, path: &str) -> Result<(), String> {
    let filelist = serde_json::to_string(&[path]).map_err(|e| e.to_string())?;
    let url = format!("{PAN}/file?method=filemanager&opera=delete&access_token={}", urlencoding(&tokens.access_token));
    let form = [("async", "0"), ("filelist", &filelist)];
    let resp = http()?
        .post(&url)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("百度 delete 失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    match check_errno(&text) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("errno -9") => Ok(()), // 不存在视为已删
        Err(e) => Err(e),
    }
}
