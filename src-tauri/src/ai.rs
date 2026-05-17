use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const STREAM_TOTAL_TIMEOUT_SECS: u64 = 600;
const STREAM_READ_TIMEOUT_SECS: u64 = 90;
const MAX_SSE_BUFFER_BYTES: usize = 1024 * 1024;

/// 桌面应用长跑：全局共享两个 reqwest::Client（非流式 60s / 流式 600s），
/// 复用 HTTP keep-alive 连接池，避免每次聊天都重新 TLS 握手。
/// 注意：reqwest::Client 内部用 Arc，clone 是零成本，但这里走静态引用更明确。
fn http_chat_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("build chat http client")
    })
}

fn http_stream_client() -> &'static reqwest::Client {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    CELL.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(STREAM_TOTAL_TIMEOUT_SECS))
            .read_timeout(Duration::from_secs(STREAM_READ_TIMEOUT_SECS))
            .build()
            .expect("build stream http client")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMsg {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: String, // "anthropic" | "openai" | "ollama" | "deepseek" | "google" | "custom"
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub model: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system: Option<String>,
    pub messages: Vec<ChatMsg>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub text: String,
    pub model: Option<String>,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
}

pub async fn chat(req: ChatRequest) -> Result<ChatResponse, String> {
    match req.provider.as_str() {
        "anthropic" => call_anthropic(req).await,
        "google" => call_google(req).await,
        // openai 兼容协议覆盖 openai / deepseek / ollama / custom
        _ => call_openai_compat(req).await,
    }
}

async fn call_google(req: ChatRequest) -> Result<ChatResponse, String> {
    let key = req
        .api_key
        .clone()
        .ok_or_else(|| "缺少 API Key".to_string())?;
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());
    let model = if req.model.is_empty() {
        "gemini-2.5-flash".to_string()
    } else {
        req.model.clone()
    };
    let url = format!(
        "{}/v1beta/models/{}:generateContent?key={}",
        endpoint.trim_end_matches('/'),
        model,
        urlencode_val(&key)
    );

    let contents: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::Assistant => "model",
                _ => "user",
            };
            serde_json::json!({
                "role": role,
                "parts": [{ "text": m.content }],
            })
        })
        .collect();

    let mut payload = serde_json::json!({
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": req.max_tokens.unwrap_or(4096),
        }
    });
    if let Some(t) = req.temperature {
        payload["generationConfig"]["temperature"] = serde_json::json!(t);
    }
    if let Some(sys) = req.system.as_ref() {
        payload["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
    }

    let client = http_chat_client();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("Google API {}: {}", status, truncate(&body, 400)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败：{e}"))?;
    let text = v
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let usage = v.get("usageMetadata").cloned();
    let input_tokens = usage
        .as_ref()
        .and_then(|u| u.get("promptTokenCount"))
        .and_then(|n| n.as_u64())
        .map(|n| n as u32);
    let output_tokens = usage
        .as_ref()
        .and_then(|u| u.get("candidatesTokenCount"))
        .and_then(|n| n.as_u64())
        .map(|n| n as u32);
    Ok(ChatResponse {
        text,
        model: Some(model),
        input_tokens,
        output_tokens,
    })
}

fn urlencode_val(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn call_anthropic(req: ChatRequest) -> Result<ChatResponse, String> {
    let key = req
        .api_key
        .clone()
        .ok_or_else(|| "缺少 API Key，请到 设置 → AI 助手 填上".to_string())?;
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}/v1/messages", endpoint.trim_end_matches('/'));

    let mut payload = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "messages": req
            .messages
            .iter()
            .map(|m| {
                serde_json::json!({
                    "role": match m.role { Role::Assistant => "assistant", _ => "user" },
                    "content": m.content,
                })
            })
            .collect::<Vec<_>>(),
    });
    if let Some(sys) = req.system.as_ref() {
        payload["system"] = serde_json::json!(sys);
    }
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
    }

    let client = http_chat_client();
    let resp = client
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Anthropic API {}: {}",
            status,
            truncate(&body, 400)
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败：{e}"))?;
    let text = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let usage = v.get("usage").cloned();
    let input_tokens = usage
        .as_ref()
        .and_then(|u| u.get("input_tokens"))
        .and_then(|n| n.as_u64())
        .map(|n| n as u32);
    let output_tokens = usage
        .as_ref()
        .and_then(|u| u.get("output_tokens"))
        .and_then(|n| n.as_u64())
        .map(|n| n as u32);
    Ok(ChatResponse {
        text,
        model: v
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string()),
        input_tokens,
        output_tokens,
    })
}

async fn call_openai_compat(req: ChatRequest) -> Result<ChatResponse, String> {
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| match req.provider.as_str() {
            "openai" => "https://api.openai.com/v1".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            "ollama" => "http://127.0.0.1:11434/v1".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        });
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = req.system.as_ref() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in req.messages.iter() {
        let role = match m.role {
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::User => "user",
        };
        messages.push(serde_json::json!({ "role": role, "content": m.content }));
    }
    let mut payload = serde_json::json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens.unwrap_or(4096),
    });
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
    }

    let client = http_chat_client();
    let mut builder = client.post(&url).header("content-type", "application/json");
    if let Some(k) = req.api_key.as_ref() {
        if !k.is_empty() {
            builder = builder.bearer_auth(k);
        }
    }
    let resp = builder
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("API {}: {}", status, truncate(&body, 400)));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败：{e}"))?;
    let text = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let usage = v.get("usage").cloned();
    let input_tokens = usage
        .as_ref()
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|n| n.as_u64())
        .map(|n| n as u32);
    let output_tokens = usage
        .as_ref()
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|n| n.as_u64())
        .map(|n| n as u32);
    Ok(ChatResponse {
        text,
        model: v
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string()),
        input_tokens,
        output_tokens,
    })
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

// ─── 流式 chat ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
pub enum StreamEvent {
    Chunk {
        delta: String,
    },
    Done {
        input_tokens: Option<u32>,
        output_tokens: Option<u32>,
        model: Option<String>,
    },
    Error {
        message: String,
    },
}

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CELL: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII：拿在手里就是注册状态，drop 时（panic / 正常返回 / await 被丢弃）自动注销，
/// 避免 cancels HashMap 在长跑桌面进程里累积野指针。
struct StreamCancelGuard {
    id: String,
    flag: Arc<AtomicBool>,
}

impl StreamCancelGuard {
    fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl Drop for StreamCancelGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = cancels().lock() {
            map.remove(&self.id);
        }
    }
}

fn register_stream(id: &str) -> StreamCancelGuard {
    let flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = cancels().lock() {
        map.insert(id.to_string(), flag.clone());
    }
    StreamCancelGuard {
        id: id.to_string(),
        flag,
    }
}

pub fn cancel_stream(id: &str) {
    if let Ok(map) = cancels().lock() {
        if let Some(flag) = map.get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

fn emit(app: &AppHandle, id: &str, evt: StreamEvent) {
    let _ = app.emit(&format!("ai-stream-{id}"), evt);
}

pub async fn chat_stream(app: AppHandle, stream_id: String, req: ChatRequest) {
    let guard = register_stream(&stream_id);
    let cancel = guard.flag();
    let result = match req.provider.as_str() {
        "anthropic" => stream_anthropic(&app, &stream_id, req, cancel.clone()).await,
        "google" => stream_google(&app, &stream_id, req, cancel.clone()).await,
        _ => stream_openai_compat(&app, &stream_id, req, cancel.clone()).await,
    };
    if let Err(msg) = result {
        if !cancel.load(Ordering::SeqCst) {
            emit(&app, &stream_id, StreamEvent::Error { message: msg });
        }
    }
    drop(guard);
}

/// 按 SSE 协议从字节流中切出 `data: ...` 负载。
struct SseReader {
    buf: String,
}

impl SseReader {
    fn new() -> Self {
        Self { buf: String::new() }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<(), String> {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        if self.buf.len() > MAX_SSE_BUFFER_BYTES {
            return Err("SSE 响应过大，已中断连接".to_string());
        }
        Ok(())
    }

    /// 取出所有完整 event（以空行分隔），返回 data: 行的合并文本。
    fn drain_events(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            let Some(idx) = self.buf.find("\n\n").or_else(|| self.buf.find("\r\n\r\n")) else {
                break;
            };
            let sep_len = if self.buf[idx..].starts_with("\r\n\r\n") {
                4
            } else {
                2
            };
            let event_block: String = self.buf.drain(..idx + sep_len).collect();
            let mut data = String::new();
            for line in event_block.lines() {
                let line = line.trim_end_matches('\r');
                if let Some(rest) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(rest.trim_start());
                }
            }
            if !data.is_empty() {
                out.push(data);
            }
        }
        out
    }
}

async fn stream_openai_compat(
    app: &AppHandle,
    stream_id: &str,
    req: ChatRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| match req.provider.as_str() {
            "openai" => "https://api.openai.com/v1".to_string(),
            "deepseek" => "https://api.deepseek.com/v1".to_string(),
            "ollama" => "http://127.0.0.1:11434/v1".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        });
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = req.system.as_ref() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in req.messages.iter() {
        let role = match m.role {
            Role::Assistant => "assistant",
            Role::System => "system",
            Role::User => "user",
        };
        messages.push(serde_json::json!({ "role": role, "content": m.content }));
    }
    let mut payload = serde_json::json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
    }

    let client = http_stream_client();
    let mut builder = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream");
    if let Some(k) = req.api_key.as_ref() {
        if !k.is_empty() {
            builder = builder.bearer_auth(k);
        }
    }
    let resp = builder
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API {}: {}", status, truncate(&body, 400)));
    }

    let mut stream = resp.bytes_stream();
    let mut sse = SseReader::new();
    let mut input_tokens: Option<u32> = None;
    let mut output_tokens: Option<u32> = None;
    let mut model: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| format!("流读取失败：{e}"))?;
        sse.push(&bytes)?;
        for data in sse.drain_events() {
            if data == "[DONE]" {
                emit(
                    app,
                    stream_id,
                    StreamEvent::Done {
                        input_tokens,
                        output_tokens,
                        model: model.clone(),
                    },
                );
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            if model.is_none() {
                model = v.get("model").and_then(|m| m.as_str()).map(String::from);
            }
            if let Some(usage) = v.get("usage") {
                input_tokens = usage
                    .get("prompt_tokens")
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32)
                    .or(input_tokens);
                output_tokens = usage
                    .get("completion_tokens")
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32)
                    .or(output_tokens);
            }
            let delta = v
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            if !delta.is_empty() {
                emit(
                    app,
                    stream_id,
                    StreamEvent::Chunk {
                        delta: delta.to_string(),
                    },
                );
            }
        }
    }
    emit(
        app,
        stream_id,
        StreamEvent::Done {
            input_tokens,
            output_tokens,
            model,
        },
    );
    Ok(())
}

async fn stream_anthropic(
    app: &AppHandle,
    stream_id: &str,
    req: ChatRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let key = req
        .api_key
        .clone()
        .ok_or_else(|| "缺少 API Key，请到 设置 → AI 助手 填上".to_string())?;
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}/v1/messages", endpoint.trim_end_matches('/'));

    let mut payload = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "stream": true,
        "messages": req
            .messages
            .iter()
            .map(|m| {
                serde_json::json!({
                    "role": match m.role { Role::Assistant => "assistant", _ => "user" },
                    "content": m.content,
                })
            })
            .collect::<Vec<_>>(),
    });
    if let Some(sys) = req.system.as_ref() {
        payload["system"] = serde_json::json!(sys);
    }
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
    }

    let client = http_stream_client();
    let resp = client
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Anthropic API {}: {}",
            status,
            truncate(&body, 400)
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut sse = SseReader::new();
    let mut input_tokens: Option<u32> = None;
    let mut output_tokens: Option<u32> = None;
    let mut model: Option<String> = None;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| format!("流读取失败：{e}"))?;
        sse.push(&bytes)?;
        for data in sse.drain_events() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match ty {
                "message_start" => {
                    if let Some(msg) = v.get("message") {
                        if model.is_none() {
                            model = msg.get("model").and_then(|m| m.as_str()).map(String::from);
                        }
                        if let Some(u) = msg.get("usage") {
                            input_tokens = u
                                .get("input_tokens")
                                .and_then(|n| n.as_u64())
                                .map(|n| n as u32)
                                .or(input_tokens);
                        }
                    }
                }
                "content_block_delta" => {
                    if let Some(delta) = v
                        .get("delta")
                        .and_then(|d| d.get("text"))
                        .and_then(|s| s.as_str())
                    {
                        if !delta.is_empty() {
                            emit(
                                app,
                                stream_id,
                                StreamEvent::Chunk {
                                    delta: delta.to_string(),
                                },
                            );
                        }
                    }
                }
                "message_delta" => {
                    if let Some(u) = v.get("usage") {
                        output_tokens = u
                            .get("output_tokens")
                            .and_then(|n| n.as_u64())
                            .map(|n| n as u32)
                            .or(output_tokens);
                    }
                }
                "message_stop" => {
                    emit(
                        app,
                        stream_id,
                        StreamEvent::Done {
                            input_tokens,
                            output_tokens,
                            model: model.clone(),
                        },
                    );
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    emit(
        app,
        stream_id,
        StreamEvent::Done {
            input_tokens,
            output_tokens,
            model,
        },
    );
    Ok(())
}

async fn stream_google(
    app: &AppHandle,
    stream_id: &str,
    req: ChatRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let key = req
        .api_key
        .clone()
        .ok_or_else(|| "缺少 API Key".to_string())?;
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());
    let model = if req.model.is_empty() {
        "gemini-2.5-flash".to_string()
    } else {
        req.model.clone()
    };
    let url = format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
        endpoint.trim_end_matches('/'),
        model,
        urlencode_val(&key),
    );

    let contents: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::Assistant => "model",
                _ => "user",
            };
            serde_json::json!({
                "role": role,
                "parts": [{ "text": m.content }],
            })
        })
        .collect();

    let mut payload = serde_json::json!({
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": req.max_tokens.unwrap_or(4096),
        }
    });
    if let Some(t) = req.temperature {
        payload["generationConfig"]["temperature"] = serde_json::json!(t);
    }
    if let Some(sys) = req.system.as_ref() {
        payload["systemInstruction"] = serde_json::json!({ "parts": [{ "text": sys }] });
    }

    let client = http_stream_client();
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Google API {}: {}", status, truncate(&body, 400)));
    }

    let mut stream = resp.bytes_stream();
    let mut sse = SseReader::new();
    let mut input_tokens: Option<u32> = None;
    let mut output_tokens: Option<u32> = None;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| format!("流读取失败：{e}"))?;
        sse.push(&bytes)?;
        for data in sse.drain_events() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            if let Some(parts) = v
                .get("candidates")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.as_array())
            {
                let delta: String = parts
                    .iter()
                    .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
                if !delta.is_empty() {
                    emit(app, stream_id, StreamEvent::Chunk { delta });
                }
            }
            if let Some(u) = v.get("usageMetadata") {
                input_tokens = u
                    .get("promptTokenCount")
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32)
                    .or(input_tokens);
                output_tokens = u
                    .get("candidatesTokenCount")
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32)
                    .or(output_tokens);
            }
        }
    }
    emit(
        app,
        stream_id,
        StreamEvent::Done {
            input_tokens,
            output_tokens,
            model: Some(model),
        },
    );
    Ok(())
}
