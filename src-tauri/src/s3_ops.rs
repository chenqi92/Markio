// S3 兼容上传（AWS / 阿里 OSS / 七牛 / Cloudflare R2 / 自建 MinIO 都走同一路径）
//
// 包含 PUT / GET / DELETE 单对象，以及 ListObjectsV2。
// 自己实现 SigV4 签名而非引入 rust-s3 全家桶，避免拖入大量传递依赖。

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub endpoint: String, // e.g. https://s3.amazonaws.com or https://oss-cn-hangzhou.aliyuncs.com
    pub region: String,   // e.g. us-east-1
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 上传后用来拼公开 URL 的 base；空时用 endpoint/bucket 推导
    pub public_base_url: Option<String>,
    /// "auto" / "us-east-1"...
    pub path_style: Option<bool>, // 默认 false（virtual-hosted style）
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn hmac256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac key");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// 按字符（而非字节）安全截断，避免在多字节 UTF-8 中间切片 panic（OSS/MinIO 错误响应可能含中文）。
fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

fn iso8601_now() -> (String, String) {
    let now = chrono::Utc::now();
    let dt = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    (dt, date)
}

fn uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let c = b as char;
        let safe = c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '~' || c == '.';
        if safe || (!encode_slash && c == '/') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn endpoint_url(endpoint: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(endpoint.trim()).map_err(|e| format!("S3 endpoint 无效：{e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("S3 endpoint 仅支持 http/https".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "S3 endpoint 缺少 host".to_string())?;
    if url.scheme() == "http" && !is_loopback_host(host) {
        return Err("S3 endpoint 不允许使用非本机 http 明文连接".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("S3 endpoint 不能包含用户名或密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("S3 endpoint 不能包含 query 或 fragment".to_string());
    }
    if !matches!(url.path(), "" | "/") {
        return Err("S3 endpoint 不能包含路径，请只填写服务根地址".to_string());
    }
    Ok(url)
}

fn authority(url: &reqwest::Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "S3 endpoint 缺少 host".to_string())?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.starts_with('/') {
        return Err("S3 key 不能为空或以 / 开头".to_string());
    }
    if key.contains('\n') || key.contains('\r') || key.contains('\0') {
        return Err("S3 key 包含非法控制字符".to_string());
    }
    if key
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Err("S3 key 不能包含空段、. 或 ..".to_string());
    }
    Ok(())
}

fn validate_bucket(bucket: &str) -> Result<(), String> {
    if !(3..=63).contains(&bucket.len()) {
        return Err("S3 bucket 长度必须在 3-63 之间".to_string());
    }
    if !bucket
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
    {
        return Err("S3 bucket 只能包含小写字母、数字、- 和 .".to_string());
    }
    Ok(())
}

pub const MAX_S3_UPLOAD: usize = 50 * 1024 * 1024; // 50 MB / object
pub const MAX_S3_DOWNLOAD: usize = 50 * 1024 * 1024; // 50 MB / object

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Object {
    pub key: String,
    pub size: u64,
    pub etag: String,
    pub last_modified: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ListResult {
    pub objects: Vec<S3Object>,
    pub is_truncated: bool,
    pub next_continuation_token: Option<String>,
}

/// 给定 bucket + endpoint + path_style，返回 (host, request_url_base)
/// host 用于 SigV4 中 Host header；url_base 是发请求时拼路径之前的部分。
fn resolve_host_and_url_base(
    cfg: &S3Config,
    endpoint: &reqwest::Url,
) -> Result<(String, String), String> {
    let endpoint_authority = authority(endpoint)?;
    let path_style = cfg.path_style.unwrap_or(false);
    if path_style {
        Ok((
            endpoint_authority.clone(),
            format!("{}://{}", endpoint.scheme(), endpoint_authority),
        ))
    } else {
        let host = format!("{}.{}", cfg.bucket, endpoint_authority);
        Ok((host.clone(), format!("{}://{}", endpoint.scheme(), host)))
    }
}

/// 给定 method / canonical_uri / canonical_query / headers (sorted) / payload，
/// 返回 (authorization, amz_date, payload_hash)
#[allow(clippy::too_many_arguments)]
fn sign_request(
    cfg: &S3Config,
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    host: &str,
    content_type: Option<&str>,
    payload: &[u8],
) -> (String, String, String) {
    let (amz_date, date_stamp) = iso8601_now();
    let payload_hash = sha256_hex(payload);

    // 注意 header 必须按 ascii 名称排序
    let mut signed_keys: Vec<&str> = vec!["host", "x-amz-content-sha256", "x-amz-date"];
    if content_type.is_some() {
        signed_keys.push("content-type");
    }
    signed_keys.sort();
    let signed_headers = signed_keys.join(";");

    let mut canonical_headers = String::new();
    for k in &signed_keys {
        let v = match *k {
            "host" => host.to_string(),
            "x-amz-content-sha256" => payload_hash.clone(),
            "x-amz-date" => amz_date.clone(),
            "content-type" => content_type.unwrap_or("").to_string(),
            _ => String::new(),
        };
        canonical_headers.push_str(&format!("{k}:{v}\n"));
    }

    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let region = if cfg.region.is_empty() {
        "us-east-1"
    } else {
        cfg.region.as_str()
    };
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        credential_scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac256(
        format!("AWS4{}", cfg.secret_access_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac256(&k_date, region.as_bytes());
    let k_service = hmac256(&k_region, b"s3");
    let k_signing = hmac256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        cfg.access_key_id, credential_scope, signed_headers, signature
    );
    (authorization, amz_date, payload_hash)
}

fn check_credentials(cfg: &S3Config) -> Result<(), String> {
    if cfg.access_key_id.trim().is_empty() || cfg.secret_access_key.trim().is_empty() {
        return Err("S3 access key 或 secret key 为空".to_string());
    }
    Ok(())
}

pub async fn list_objects(
    cfg: &S3Config,
    prefix: &str,
    continuation_token: Option<&str>,
    max_keys: u32,
) -> Result<S3ListResult, String> {
    validate_bucket(&cfg.bucket)?;
    check_credentials(cfg)?;
    let endpoint = endpoint_url(&cfg.endpoint)?;
    let (host, url_base) = resolve_host_and_url_base(cfg, &endpoint)?;
    let path_style = cfg.path_style.unwrap_or(false);

    let canonical_uri = if path_style {
        format!("/{}", cfg.bucket)
    } else {
        "/".to_string()
    };

    // canonical query 必须按 key URI-encoded 排序后拼接
    let mut params: Vec<(String, String)> = vec![("list-type".to_string(), "2".to_string())];
    if !prefix.is_empty() {
        params.push(("prefix".to_string(), prefix.to_string()));
    }
    if let Some(token) = continuation_token {
        if !token.is_empty() {
            params.push(("continuation-token".to_string(), token.to_string()));
        }
    }
    let max_keys = max_keys.clamp(1, 1000);
    params.push(("max-keys".to_string(), max_keys.to_string()));
    params.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_query = params
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    let (authorization, amz_date, payload_hash) = sign_request(
        cfg,
        "GET",
        &canonical_uri,
        &canonical_query,
        &host,
        None,
        &[],
    );

    let full_url = format!("{url_base}{canonical_uri}?{canonical_query}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(crate::safe_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&full_url)
        .header("Authorization", authorization)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .send()
        .await
        .map_err(|e| format!("S3 LIST 失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("S3 LIST 读响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "S3 LIST HTTP {}: {}",
            status,
            truncate_chars(&body, 400)
        ));
    }
    parse_list_xml(&body)
}

fn parse_list_xml(xml: &str) -> Result<S3ListResult, String> {
    // 简易 XML 抽取：S3 ListObjectsV2 响应结构稳定；这里手写避免再加一个依赖
    let mut objects: Vec<S3Object> = Vec::new();
    let mut pos = 0;
    while let Some(start) = xml[pos..].find("<Contents>") {
        let s = pos + start;
        let end = match xml[s..].find("</Contents>") {
            Some(e) => s + e,
            None => break,
        };
        let chunk = &xml[s..end];
        let key = extract_tag(chunk, "Key").unwrap_or_default();
        let size = extract_tag(chunk, "Size")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let etag = extract_tag(chunk, "ETag")
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let last_modified = extract_tag(chunk, "LastModified").unwrap_or_default();
        objects.push(S3Object {
            key,
            size,
            etag,
            last_modified,
        });
        pos = end + "</Contents>".len();
    }
    let is_truncated = extract_tag(xml, "IsTruncated")
        .map(|v| v.trim() == "true")
        .unwrap_or(false);
    let next_continuation_token = extract_tag(xml, "NextContinuationToken");
    Ok(S3ListResult {
        objects,
        is_truncated,
        next_continuation_token,
    })
}

fn extract_tag(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let i = s.find(&open)?;
    let j = s[i + open.len()..].find(&close)?;
    Some(s[i + open.len()..i + open.len() + j].to_string())
}

pub async fn get_object(cfg: &S3Config, key: &str) -> Result<Vec<u8>, String> {
    validate_bucket(&cfg.bucket)?;
    validate_key(key)?;
    check_credentials(cfg)?;
    let endpoint = endpoint_url(&cfg.endpoint)?;
    let (host, url_base) = resolve_host_and_url_base(cfg, &endpoint)?;
    let path_style = cfg.path_style.unwrap_or(false);
    let canonical_uri = if path_style {
        format!("/{}/{}", cfg.bucket, uri_encode(key, false))
    } else {
        format!("/{}", uri_encode(key, false))
    };
    let (authorization, amz_date, payload_hash) =
        sign_request(cfg, "GET", &canonical_uri, "", &host, None, &[]);

    let full_url = format!("{url_base}{canonical_uri}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(crate::safe_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&full_url)
        .header("Authorization", authorization)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .send()
        .await
        .map_err(|e| format!("S3 GET 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "S3 GET HTTP {}: {}",
            status,
            truncate_chars(&text, 400)
        ));
    }
    crate::read_capped(resp, MAX_S3_DOWNLOAD, "S3").await
}

pub async fn delete_object(cfg: &S3Config, key: &str) -> Result<(), String> {
    validate_bucket(&cfg.bucket)?;
    validate_key(key)?;
    check_credentials(cfg)?;
    let endpoint = endpoint_url(&cfg.endpoint)?;
    let (host, url_base) = resolve_host_and_url_base(cfg, &endpoint)?;
    let path_style = cfg.path_style.unwrap_or(false);
    let canonical_uri = if path_style {
        format!("/{}/{}", cfg.bucket, uri_encode(key, false))
    } else {
        format!("/{}", uri_encode(key, false))
    };
    let (authorization, amz_date, payload_hash) =
        sign_request(cfg, "DELETE", &canonical_uri, "", &host, None, &[]);

    let full_url = format!("{url_base}{canonical_uri}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(crate::safe_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .delete(&full_url)
        .header("Authorization", authorization)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .send()
        .await
        .map_err(|e| format!("S3 DELETE 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 404 {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "S3 DELETE HTTP {}: {}",
            status,
            truncate_chars(&text, 400)
        ));
    }
    Ok(())
}

pub async fn put_object(
    cfg: &S3Config,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<String, String> {
    validate_bucket(&cfg.bucket)?;
    validate_key(key)?;
    if cfg.access_key_id.trim().is_empty() || cfg.secret_access_key.trim().is_empty() {
        return Err("S3 access key 或 secret key 为空".to_string());
    }
    if content_type.len() > 200 || content_type.contains('\n') || content_type.contains('\r') {
        return Err("Content-Type 无效".to_string());
    }
    if body.len() > MAX_S3_UPLOAD {
        return Err(format!(
            "S3 单对象上传超过上限：{} bytes > {} bytes",
            body.len(),
            MAX_S3_UPLOAD
        ));
    }
    let endpoint = endpoint_url(&cfg.endpoint)?;
    let (host, url_base) = resolve_host_and_url_base(cfg, &endpoint)?;
    let path_style = cfg.path_style.unwrap_or(false);
    let canonical_uri = if path_style {
        format!("/{}/{}", cfg.bucket, uri_encode(key, false))
    } else {
        format!("/{}", uri_encode(key, false))
    };
    let full_url = format!("{url_base}{canonical_uri}");

    // 复用 sign_request（含 content-type 分支），不再重复一份 SigV4 实现，避免两处签名 drift。
    let (authorization, amz_date, payload_hash) = sign_request(
        cfg,
        "PUT",
        &canonical_uri,
        "",
        &host,
        Some(content_type),
        &body,
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(crate::safe_redirect_policy())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .put(&full_url)
        .header("Authorization", authorization)
        .header("Content-Type", content_type)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("S3 PUT 失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "S3 PUT HTTP {}: {}",
            status,
            truncate_chars(&text, 400)
        ));
    }
    // 公开 URL
    let public = if let Some(base) = cfg.public_base_url.as_ref().filter(|s| !s.is_empty()) {
        let base = reqwest::Url::parse(base).map_err(|e| format!("S3 public URL 无效：{e}"))?;
        format!(
            "{}/{}",
            base.as_str().trim_end_matches('/'),
            uri_encode(key, false)
        )
    } else {
        full_url
    };
    Ok(public)
}
