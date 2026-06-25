// Synology FileStation 集成：SYNO.API.Auth 登录拿 sid + SYNO.FileStation.* 文件操作。
//
// NAS 常在局域网用 http(5000) 或自签证书 https(5001)，因此 base_url 校验比公网网盘宽松
// （用户显式配置的设备地址），并提供「忽略 TLS 证书」开关给自签证书场景。
// 账号 / 密码：用户名走设置，密码进钥匙串；登录得到的 sid 由前端在一次同步内复用。
//
// 文档：Synology File Station Official API（SYNO.API.Auth / SYNO.FileStation.List/Download/
// Upload/CreateFolder/Delete）。

use serde::Serialize;
use std::time::Duration;

pub const MAX_SYNOLOGY_OBJECT: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynologyLogin {
    pub sid: String,
    /// 是否已记住此设备（拿到/已有设备令牌）→ 之后自动同步重登无需再输 OTP
    pub device_remembered: bool,
}

/// 登录原始结果：sid + 本次返回的设备令牌（仅 2FA + enable_device_token 时有）
pub struct SynologyLoginRaw {
    pub sid: String,
    pub did: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynologyEntry {
    pub name: String,
    /// NAS 绝对路径，例如 /markio/notes/a.md
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// mtime（Unix 秒）
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynologyList {
    pub entries: Vec<SynologyEntry>,
}

/// NAS 地址校验：http/https，必须有 host，不允许内嵌账号密码。比公网网盘宽松，
/// 允许局域网 http（用户自己配置的设备，非文档可控）。返回归一化后的 base（去尾斜杠）。
pub fn validate_base_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Synology 地址为空".to_string());
    }
    let url = reqwest::Url::parse(trimmed).map_err(|e| format!("Synology 地址无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Synology 仅支持 http/https".to_string());
    }
    if url.host_str().is_none() {
        return Err("Synology 地址缺少主机名".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Synology 地址不能包含用户名或密码".to_string());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn client(insecure_tls: bool) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().timeout(Duration::from_secs(90));
    if insecure_tls {
        b = b.danger_accept_invalid_certs(true);
    }
    b.build().map_err(|e| e.to_string())
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

fn syno_error_message(code: i64) -> String {
    let m = match code {
        400 => "账号或密码错误",
        401 => "账号被禁用",
        402 => "权限不足",
        403 => "需要二步验证 OTP 码",
        404 => "OTP 码错误",
        406 => "强制开启 OTP，请在 NAS 上设置",
        407 => "IP 被封锁",
        408 => "密码已过期需重置",
        409 => "密码已过期",
        410 => "密码必须修改",
        119 => "sid 失效，请重新登录",
        _ => "",
    };
    if m.is_empty() {
        format!("Synology API 错误码 {code}")
    } else {
        format!("Synology：{m}（{code}）")
    }
}

/// 解析 Synology 标准响应 `{success, data, error:{code}}`，成功返回 data。
fn take_data(text: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Synology 响应解析失败：{e}; body={text}"))?;
    if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
        Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        let code = v
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(|c| c.as_i64())
            .unwrap_or(-1);
        Err(syno_error_message(code))
    }
}

/// 用账号密码登录 FileStation。
///
/// - `otp_code`：二步验证一次性码（仅首次/令牌失效时需要）。
/// - `device_id`：之前记住的设备令牌；带上它且令牌有效时**跳过 OTP**，让自动同步无人值守。
///
/// 始终带 `enable_device_token=yes` + `device_name`，所以 2FA 首次用 OTP 登录成功后，
/// 群晖会返回设备令牌 `did`，调用方应存起来下次当 `device_id` 传回。
///
/// 账号开了 2FA 但既没给 OTP 也没给有效设备令牌时，群晖返回错误码 403，本函数会把它
/// 翻成含「需要二步验证」的错误，前端据此提示补 OTP。
pub async fn login(
    base: &str,
    insecure_tls: bool,
    account: &str,
    password: &str,
    otp_code: Option<&str>,
    device_id: Option<&str>,
) -> Result<SynologyLoginRaw, String> {
    let client = client(insecure_tls)?;
    let mut form: Vec<(&str, &str)> = vec![
        ("api", "SYNO.API.Auth"),
        ("version", "6"),
        ("method", "login"),
        ("session", "FileStation"),
        ("format", "sid"),
        ("account", account),
        ("passwd", password),
        ("enable_device_token", "yes"),
        ("device_name", "Markio"),
    ];
    if let Some(otp) = otp_code {
        if !otp.is_empty() {
            form.push(("otp_code", otp));
        }
    }
    if let Some(did) = device_id {
        if !did.is_empty() {
            form.push(("device_id", did));
        }
    }
    let resp = client
        .post(format!("{base}/webapi/auth.cgi"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Synology 登录请求失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    let data = take_data(&text)?;
    let sid = data
        .get("sid")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Synology 登录未返回 sid".to_string())?;
    // 不同 DSM 版本设备令牌字段可能是 did 或 device_id
    let did = data
        .get("did")
        .or_else(|| data.get("device_id"))
        .and_then(|d| d.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Ok(SynologyLoginRaw { sid, did })
}

/// 列出某 NAS 绝对路径目录下的直接子项（自动翻页）。
pub async fn list(
    base: &str,
    insecure_tls: bool,
    sid: &str,
    folder_path: &str,
) -> Result<SynologyList, String> {
    let client = client(insecure_tls)?;
    let mut entries = Vec::new();
    let mut offset = 0u64;
    loop {
        let form = [
            ("api", "SYNO.FileStation.List"),
            ("version", "2"),
            ("method", "list"),
            ("folder_path", folder_path),
            ("additional", "[\"size\",\"time\"]"),
            ("offset", &offset.to_string()),
            ("limit", "1000"),
            ("_sid", sid),
        ];
        let resp = client
            .post(format!("{base}/webapi/entry.cgi"))
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("Synology list 请求失败：{e}"))?;
        let text = resp.text().await.unwrap_or_default();
        let data = match take_data(&text) {
            Ok(d) => d,
            // 408 = 目录不存在（首次同步远端根还没建）→ 视为空列表
            Err(e) if e.contains("408") => return Ok(SynologyList { entries }),
            Err(e) => return Err(e),
        };
        let files = data
            .get("files")
            .and_then(|f| f.as_array())
            .cloned()
            .unwrap_or_default();
        let total = data.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
        let got = files.len() as u64;
        for f in files {
            let name = f
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let path = f
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            let is_dir = f.get("isdir").and_then(|d| d.as_bool()).unwrap_or(false);
            let add = f.get("additional");
            let size = add
                .and_then(|a| a.get("size"))
                .and_then(|s| s.as_u64())
                .unwrap_or(0);
            let mtime = add
                .and_then(|a| a.get("time"))
                .and_then(|t| t.get("mtime"))
                .and_then(|m| m.as_i64())
                .unwrap_or(0);
            entries.push(SynologyEntry {
                name,
                path,
                is_dir,
                size,
                mtime,
            });
        }
        offset += got;
        if got == 0 || offset >= total {
            break;
        }
    }
    Ok(SynologyList { entries })
}

pub async fn download(
    base: &str,
    insecure_tls: bool,
    sid: &str,
    path: &str,
) -> Result<Vec<u8>, String> {
    let client = client(insecure_tls)?;
    let url = format!(
        "{base}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path={}&mode=download&_sid={}",
        urlencoding(path),
        urlencoding(sid),
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Synology download 请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Synology download HTTP {status}: {text}"));
    }
    // 下载失败时 NAS 可能回 JSON 错误而非文件流；按 content-type 粗判。
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if ct.contains("application/json") {
        let text = resp.text().await.unwrap_or_default();
        take_data(&text)?;
        return Err("Synology download 返回了 JSON 而非文件内容".to_string());
    }
    crate::read_capped(resp, MAX_SYNOLOGY_OBJECT, "Synology").await
}

pub async fn upload(
    base: &str,
    insecure_tls: bool,
    sid: &str,
    dest_folder: &str,
    name: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.len() > MAX_SYNOLOGY_OBJECT {
        return Err(format!(
            "Synology 单文件上传超过上限：{} > {}",
            bytes.len(),
            MAX_SYNOLOGY_OBJECT
        ));
    }
    if name.contains('/') || name.contains('\\') || name.is_empty() {
        return Err("Synology 文件名无效".to_string());
    }
    let client = client(insecure_tls)?;
    let url = format!(
        "{base}/webapi/entry.cgi?api=SYNO.FileStation.Upload&version=2&method=upload&_sid={}",
        urlencoding(sid),
    );
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name.to_string())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    // 字段顺序很关键：path / create_parents / overwrite 必须排在 file 之前。
    let form = reqwest::multipart::Form::new()
        .text("path", dest_folder.to_string())
        .text("create_parents", "true")
        .text("overwrite", "true")
        .part("file", file_part);
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Synology upload 请求失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    take_data(&text)?;
    Ok(())
}

pub async fn create_folder(
    base: &str,
    insecure_tls: bool,
    sid: &str,
    parent_path: &str,
    name: &str,
) -> Result<(), String> {
    let client = client(insecure_tls)?;
    let form = [
        ("api", "SYNO.FileStation.CreateFolder"),
        ("version", "2"),
        ("method", "create"),
        ("folder_path", parent_path),
        ("name", name),
        ("force_parent", "true"),
        ("_sid", sid),
    ];
    let resp = client
        .post(format!("{base}/webapi/entry.cgi"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Synology create_folder 请求失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    // 目录已存在时 NAS 返回 error code 1100/408 等；force_parent 下通常成功。
    // 把「已存在」当作幂等成功：success=false 但目录确实在，难以区分，这里仅吞 1100。
    match take_data(&text) {
        Ok(_) => Ok(()),
        Err(e) if e.contains("1100") => Ok(()),
        Err(e) => Err(e),
    }
}

pub async fn delete(
    base: &str,
    insecure_tls: bool,
    sid: &str,
    path: &str,
) -> Result<(), String> {
    let client = client(insecure_tls)?;
    let form = [
        ("api", "SYNO.FileStation.Delete"),
        ("version", "2"),
        ("method", "delete"),
        ("path", path),
        ("_sid", sid),
    ];
    let resp = client
        .post(format!("{base}/webapi/entry.cgi"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Synology delete 请求失败：{e}"))?;
    let text = resp.text().await.unwrap_or_default();
    take_data(&text)?;
    Ok(())
}
