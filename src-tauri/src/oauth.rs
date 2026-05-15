// OAuth 2.0 PKCE flow + 一次性 localhost 回调监听器。
//
// 用法：
//   let pkce = PkcePair::new();
//   let listener = LoopbackListener::bind().await?;
//   let port = listener.port();
//   open_browser(&auth_url_with(port, &pkce.challenge));
//   let code = listener.wait_for_code(Duration::from_secs(300)).await?;
//   let tokens = exchange_for_tokens(code, &pkce.verifier, port).await?;
//
// 只解析最小化的 HTTP 请求：一行 GET /callback?code=...&state=... HTTP/1.1。
// 没接全 HTTP/1.1，但 OAuth 回调浏览器只发一次 GET，足够。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone)]
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

impl PkcePair {
    pub fn new() -> Result<Self, String> {
        // 96 字节 → 128 字符 URL-safe base64，远超 PKCE 最低要求
        let mut buf = [0u8; 96];
        getrandom::getrandom(&mut buf).map_err(|e| format!("生成随机数失败：{e}"))?;
        let verifier = URL_SAFE_NO_PAD.encode(buf);
        let mut h = Sha256::new();
        h.update(verifier.as_bytes());
        let challenge = URL_SAFE_NO_PAD.encode(h.finalize());
        Ok(PkcePair {
            verifier,
            challenge,
        })
    }
}

pub struct LoopbackListener {
    listener: TcpListener,
    port: u16,
}

impl LoopbackListener {
    pub async fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("绑定 OAuth 回调端口失败：{e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("读取 OAuth 端口失败：{e}"))?
            .port();
        Ok(LoopbackListener { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/oauth/callback", self.port)
    }

    /// 阻塞等待浏览器回到本机 redirect_uri，返回 query 里的 code。
    /// 给定 timeout 内没收到就报错。
    /// state 给定时校验，没给就跳过。
    pub async fn wait_for_code(
        self,
        timeout: Duration,
        expected_state: Option<&str>,
    ) -> Result<String, String> {
        let res = tokio::time::timeout(timeout, self.accept_once(expected_state)).await;
        match res {
            Ok(r) => r,
            Err(_) => Err("OAuth 授权超时（5 分钟未完成）".to_string()),
        }
    }

    async fn accept_once(self, expected_state: Option<&str>) -> Result<String, String> {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|e| format!("接受 OAuth 回调失败：{e}"))?;

            // 读到第一个 \r\n\r\n 为止（OAuth 回调只发一行 GET + headers，体积很小）
            let mut buf = Vec::with_capacity(4096);
            let mut tmp = [0u8; 1024];
            loop {
                let n = match stream.read(&mut tmp).await {
                    Ok(n) => n,
                    Err(_) => break,
                };
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 8192 {
                    break;
                }
            }
            let text = String::from_utf8_lossy(&buf);
            let request_line = text.lines().next().unwrap_or("");
            // GET /oauth/callback?code=...&state=... HTTP/1.1
            let path = request_line.split_whitespace().nth(1).unwrap_or("");
            let url = format!("http://127.0.0.1{path}");
            let parsed = url::Url::parse(&url).ok();
            let code = parsed
                .as_ref()
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.to_string()));
            let state = parsed
                .as_ref()
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "state").map(|(_, v)| v.to_string()));
            let error = parsed
                .as_ref()
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "error").map(|(_, v)| v.to_string()));

            // 回浏览器一个友好页面
            let (status, html) = if let Some(err) = &error {
                (
                    "400 Bad Request",
                    format!("<html><body><h2>授权失败</h2><p>{}</p><p>可以关闭此窗口。</p></body></html>", html_escape(err)),
                )
            } else if code.is_some() {
                (
                    "200 OK",
                    "<html><body><h2>授权完成</h2><p>已成功授权，可以关闭此窗口回到 markio。</p></body></html>".to_string(),
                )
            } else {
                (
                    "400 Bad Request",
                    "<html><body><h2>未收到 code</h2><p>回调缺少 code 参数。</p></body></html>".to_string(),
                )
            };
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html.as_bytes().len(),
                html
            );
            let _ = stream.write_all(resp.as_bytes()).await;
            let _ = stream.shutdown().await;

            if let Some(err) = error {
                return Err(format!("OAuth 授权被拒绝：{err}"));
            }
            if let Some(code) = code {
                if let (Some(expected), Some(got)) = (expected_state, state.as_ref()) {
                    if expected != got {
                        return Err("OAuth state 校验失败（可能被中间人篡改）".to_string());
                    }
                }
                return Ok(code);
            }
            // 浏览器有时会发预检请求（favicon 等），忽略继续 accept
        }
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 生成 32 字节随机 state（base64 url-safe，44 字符内）
pub fn random_state() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}
