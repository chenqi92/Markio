// S3 兼容上传（AWS / 阿里 OSS / 七牛 / Cloudflare R2 / 自建 MinIO 都走同一路径）
//
// 只实现 PUT object（image 上传），不需要 list/get/multipart。
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
    let endpoint_authority = authority(&endpoint)?;
    let path_style = cfg.path_style.unwrap_or(false);
    let (full_url, host) = if path_style {
        let h = endpoint_authority.clone();
        (
            format!(
                "{}://{}/{}/{}",
                endpoint.scheme(),
                endpoint_authority,
                cfg.bucket,
                uri_encode(key, false)
            ),
            h,
        )
    } else {
        let h = format!("{}.{}", cfg.bucket, endpoint_authority);
        (
            format!("{}://{}/{}", endpoint.scheme(), h, uri_encode(key, false)),
            h,
        )
    };

    let (amz_date, date_stamp) = iso8601_now();
    let payload_hash = sha256_hex(&body);

    // canonical headers
    let canonical_headers =
        format!("content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";

    let canonical_uri = if path_style {
        format!("/{}/{}", cfg.bucket, uri_encode(key, false))
    } else {
        format!("/{}", uri_encode(key, false))
    };
    let canonical_request =
        format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");

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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
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
            &text[..text.len().min(400)]
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
