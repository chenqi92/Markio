// WebDAV 同步（最小可用版）
//
// 仅暴露 5 个原子操作：test / list / put / get / delete。
// 高层「双向同步」由前端决策：定时遍历 list → 比对 mtime → put/get。
// 把策略放在前端，是因为冲突解决要复用 settings.syncConflictStrategy 的
// "ask / newest / local / remote"。
//
// 鉴权：username + password；密码走系统钥匙串（account = `webdav:<host>`）。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};

const MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavAuth {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavEntry {
    pub href: String,
    pub is_dir: bool,
    /// 相对 base URL 的路径（已去除前导 /）
    pub rel_path: String,
    /// 单位 byte；目录或未知 → 0
    pub size: u64,
    /// 服务器报告的 last-modified，rfc3339 字符串；解析失败 → ""
    pub last_modified: String,
}

fn auth_header(auth: &WebDavAuth) -> String {
    format!(
        "Basic {}",
        STANDARD.encode(format!("{}:{}", auth.username, auth.password))
    )
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("初始化 WebDAV 客户端失败：{e}"))
}

const MAX_WEBDAV_UPLOAD: usize = 100 * 1024 * 1024; // 100 MB
const MAX_WEBDAV_AUTH_LEN: usize = 512;

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// 校验 WebDAV base URL：scheme 仅 http(s)，host 必须存在，禁止 url 内嵌凭据 /
/// query / fragment；非本机 http 一律拒绝。
fn validate_base(base_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(base_url.trim())
        .map_err(|e| format!("WebDAV base URL 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("WebDAV 仅支持 http/https".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "WebDAV base URL 缺少 host".to_string())?;
    if url.scheme() == "http" && !is_loopback_host(host) {
        return Err("WebDAV 不允许使用非本机 http 明文连接".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("WebDAV base URL 不能内嵌用户名 / 密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("WebDAV base URL 不能包含 query 或 fragment".to_string());
    }
    Ok(())
}

fn validate_auth(auth: &WebDavAuth) -> Result<(), String> {
    if auth.username.len() > MAX_WEBDAV_AUTH_LEN || auth.password.len() > MAX_WEBDAV_AUTH_LEN {
        return Err("WebDAV 凭据过长".to_string());
    }
    if auth.username.contains(['\r', '\n', '\0'])
        || auth.password.contains(['\r', '\n', '\0'])
    {
        return Err("WebDAV 凭据包含非法控制字符".to_string());
    }
    Ok(())
}

fn append_segments(url: &mut reqwest::Url, rel: &str) -> Result<(), String> {
    let normalized = rel.replace('\\', "/");
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| "WebDAV URL 不能作为 base 使用".to_string())?;
    segments.pop_if_empty();
    for segment in normalized.split('/').filter(|s| !s.is_empty()) {
        if segment == "." || segment == ".." {
            return Err("WebDAV 路径不能包含 . 或 ..".to_string());
        }
        segments.push(segment);
    }
    Ok(())
}

fn join_url(base: &str, rel: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("WebDAV base URL 无效：{e}"))?;
    append_segments(&mut url, rel)?;
    if rel.is_empty() && !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url.to_string())
}

/// 试连接：用 PROPFIND depth:0 检测可达性 + 凭据。
pub async fn test(base_url: &str, auth: &WebDavAuth) -> Result<(), String> {
    validate_base(base_url)?;
    validate_auth(auth)?;
    let client = build_client()?;
    let mut headers = HeaderMap::new();
    headers.insert("Depth", "0".parse().unwrap());
    headers.insert(
        "Content-Type",
        "application/xml; charset=utf-8".parse().unwrap(),
    );
    headers.insert("Authorization", auth_header(auth).parse().unwrap());
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#;
    let resp = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            join_url(base_url, "")?,
        )
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("WebDAV 连接失败：{e}"))?;
    let status = resp.status();
    if status.as_u16() == 207 || status.is_success() {
        return Ok(());
    }
    if status.as_u16() == 401 {
        return Err("认证失败：用户名 / 密码或应用专用密码错误".to_string());
    }
    Err(format!("WebDAV 返回 HTTP {status}"))
}

/// 列出 path 目录下的直接子条目（PROPFIND depth:1）。
/// path 必须以目录形式提供，例如 "notes/"。
pub async fn list(
    base_url: &str,
    auth: &WebDavAuth,
    path: &str,
) -> Result<Vec<WebDavEntry>, String> {
    validate_base(base_url)?;
    validate_auth(auth)?;
    let client = build_client()?;
    let mut headers = HeaderMap::new();
    headers.insert("Depth", "1".parse().unwrap());
    headers.insert(
        "Content-Type",
        "application/xml; charset=utf-8".parse().unwrap(),
    );
    headers.insert("Authorization", auth_header(auth).parse().unwrap());
    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>"#;
    let url = join_url(base_url, path)?;
    let resp = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("WebDAV list 失败：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status.as_u16() != 207 && !status.is_success() {
        return Err(format!("PROPFIND {url} 失败：HTTP {status}"));
    }
    Ok(parse_propfind(&text, base_url))
}

fn local_name(name: &[u8]) -> &[u8] {
    name.iter()
        .position(|b| *b == b':')
        .map(|idx| &name[idx + 1..])
        .unwrap_or(name)
}

fn rel_from_href(href: &str, base_url: &str) -> String {
    let base_path = reqwest::Url::parse(base_url)
        .map(|u| u.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    let path = reqwest::Url::parse(href)
        .map(|u| u.path().to_string())
        .unwrap_or_else(|_| href.to_string());
    path.trim_start_matches(&base_path)
        .trim_start_matches('/')
        .to_string()
}

fn parse_propfind(xml: &str, base_url: &str) -> Vec<WebDavEntry> {
    let mut entries = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut in_response = false;
    let mut current_tag = String::new();
    let mut current = WebDavEntry {
        href: String::new(),
        is_dir: false,
        rel_path: String::new(),
        size: 0,
        last_modified: String::new(),
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                match name.as_slice() {
                    b"response" => {
                        in_response = true;
                        current = WebDavEntry {
                            href: String::new(),
                            is_dir: false,
                            rel_path: String::new(),
                            size: 0,
                            last_modified: String::new(),
                        };
                    }
                    b"collection" if in_response => current.is_dir = true,
                    _ if in_response => {
                        current_tag = String::from_utf8_lossy(&name).to_string();
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if in_response && local_name(e.name().as_ref()) == b"collection" {
                    current.is_dir = true;
                }
            }
            Ok(Event::Text(e)) => {
                if in_response {
                    let text = String::from_utf8_lossy(e.as_ref()).trim().to_string();
                    match current_tag.as_str() {
                        "href" => current.href = text,
                        "getcontentlength" => current.size = text.parse::<u64>().unwrap_or(0),
                        "getlastmodified" => current.last_modified = text,
                        _ => {}
                    }
                }
            }
            Ok(Event::CData(e)) => {
                if in_response {
                    let text = String::from_utf8_lossy(e.as_ref()).trim().to_string();
                    match current_tag.as_str() {
                        "href" => current.href = text,
                        "getcontentlength" => current.size = text.parse::<u64>().unwrap_or(0),
                        "getlastmodified" => current.last_modified = text,
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_vec();
                if name.as_slice() == b"response" {
                    in_response = false;
                    if !current.href.is_empty() {
                        current.rel_path = rel_from_href(&current.href, base_url);
                        entries.push(current.clone());
                    }
                } else if in_response {
                    let end_tag = String::from_utf8_lossy(&name);
                    if end_tag == current_tag {
                        current_tag.clear();
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    entries
}

/// PUT body 到 rel_path。
pub async fn put(
    base_url: &str,
    auth: &WebDavAuth,
    rel_path: &str,
    body: Vec<u8>,
) -> Result<(), String> {
    validate_base(base_url)?;
    validate_auth(auth)?;
    if body.len() > MAX_WEBDAV_UPLOAD {
        return Err(format!(
            "WebDAV 单文件上传超过上限：{} bytes > {} bytes",
            body.len(),
            MAX_WEBDAV_UPLOAD
        ));
    }
    let client = build_client()?;
    let resp = client
        .put(join_url(base_url, rel_path)?)
        .header("Authorization", auth_header(auth))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("WebDAV put 失败：{e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("WebDAV put HTTP {status}"))
    }
}

pub async fn get(base_url: &str, auth: &WebDavAuth, rel_path: &str) -> Result<Vec<u8>, String> {
    validate_base(base_url)?;
    validate_auth(auth)?;
    let client = build_client()?;
    let resp = client
        .get(join_url(base_url, rel_path)?)
        .header("Authorization", auth_header(auth))
        .send()
        .await
        .map_err(|e| format!("WebDAV get 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("WebDAV get HTTP {status}"));
    }
    if resp
        .content_length()
        .is_some_and(|len| len > MAX_DOWNLOAD_BYTES)
    {
        return Err(format!(
            "WebDAV 下载内容超过大小限制：最大 {} MB",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "WebDAV 下载内容超过大小限制：最大 {} MB",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }
    Ok(bytes.to_vec())
}

pub async fn delete(base_url: &str, auth: &WebDavAuth, rel_path: &str) -> Result<(), String> {
    validate_base(base_url)?;
    validate_auth(auth)?;
    let client = build_client()?;
    let resp = client
        .delete(join_url(base_url, rel_path)?)
        .header("Authorization", auth_header(auth))
        .send()
        .await
        .map_err(|e| format!("WebDAV delete 失败：{e}"))?;
    let status = resp.status();
    if status.is_success() || status.as_u16() == 404 {
        Ok(())
    } else {
        Err(format!("WebDAV delete HTTP {status}"))
    }
}

pub async fn mkcol(base_url: &str, auth: &WebDavAuth, rel_path: &str) -> Result<(), String> {
    validate_base(base_url)?;
    validate_auth(auth)?;
    let client = build_client()?;
    let resp = client
        .request(
            reqwest::Method::from_bytes(b"MKCOL").unwrap(),
            join_url(base_url, rel_path)?,
        )
        .header("Authorization", auth_header(auth))
        .send()
        .await
        .map_err(|e| format!("WebDAV mkcol 失败：{e}"))?;
    let status = resp.status();
    if status.is_success() || status.as_u16() == 405 {
        // 405 = already exists
        Ok(())
    } else {
        Err(format!("WebDAV mkcol HTTP {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_ok() -> WebDavAuth {
        WebDavAuth {
            username: "u".into(),
            password: "p".into(),
        }
    }

    #[test]
    fn parses_collection_and_file() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/notes/</d:href>
    <d:propstat><d:prop>
      <d:resourcetype><d:collection/></d:resourcetype>
      <d:getlastmodified>Mon, 01 Jan 2024 10:00:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/notes/a.md</d:href>
    <d:propstat><d:prop>
      <d:resourcetype/>
      <d:getcontentlength>1234</d:getcontentlength>
      <d:getlastmodified>Tue, 02 Jan 2024 11:00:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;
        let entries = parse_propfind(xml, "https://host.example.com/dav");
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].rel_path, "notes/");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].rel_path, "notes/a.md");
        assert_eq!(entries[1].size, 1234);
    }

    #[test]
    fn rejects_non_http_scheme() {
        assert!(validate_base("ftp://example.com/").is_err());
        assert!(validate_base("file:///etc/passwd").is_err());
    }

    #[test]
    fn rejects_http_to_remote_host() {
        assert!(validate_base("http://example.com/dav").is_err());
    }

    #[test]
    fn allows_http_loopback() {
        assert!(validate_base("http://127.0.0.1:8080/dav").is_ok());
        assert!(validate_base("http://localhost/").is_ok());
    }

    #[test]
    fn rejects_url_with_embedded_credentials() {
        assert!(validate_base("https://user:pw@example.com/dav").is_err());
    }

    #[test]
    fn rejects_auth_with_control_chars() {
        let a = WebDavAuth {
            username: "u\n".into(),
            password: "p".into(),
        };
        assert!(validate_auth(&a).is_err());
        assert!(validate_auth(&auth_ok()).is_ok());
    }

    #[test]
    fn join_url_blocks_path_traversal() {
        let r = join_url("https://example.com/dav/", "../etc/passwd");
        assert!(r.is_err());
    }

    #[test]
    fn join_url_appends_relative_segments() {
        let r = join_url("https://example.com/dav/", "notes/a.md").unwrap();
        assert_eq!(r, "https://example.com/dav/notes/a.md");
    }
}
