use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const STREAM_TOTAL_TIMEOUT_SECS: u64 = 600;
const STREAM_READ_TIMEOUT_SECS: u64 = 90;
const MAX_SSE_BUFFER_BYTES: usize = 1024 * 1024;
/// 每个 provider 60 秒内最多放 30 个请求过；超出的请求 sleep 到窗口空出再走。
/// 桌面端用户快速连点发送 / 手抖快捷键时不至于秒爆 API 配额。
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_MAX_PER_WINDOW: usize = 30;

/// 简易滑动窗口限流器：记录每次请求时间戳，drain 超出窗口的旧时间。
struct RateBucket {
    times: VecDeque<Instant>,
}

impl RateBucket {
    fn new() -> Self {
        Self {
            times: VecDeque::new(),
        }
    }

    /// 返回需要等待的时长；0 表示可以立即通过，>0 则 sleep 之后再试。
    fn check(&mut self) -> Duration {
        let now = Instant::now();
        while let Some(t) = self.times.front() {
            if now.duration_since(*t) >= RATE_WINDOW {
                self.times.pop_front();
            } else {
                break;
            }
        }
        if self.times.len() < RATE_MAX_PER_WINDOW {
            self.times.push_back(now);
            return Duration::ZERO;
        }
        // 最老的时间戳什么时候出窗口
        let oldest = *self.times.front().unwrap();
        RATE_WINDOW.saturating_sub(now.duration_since(oldest))
    }
}

fn rate_buckets() -> &'static Mutex<HashMap<String, RateBucket>> {
    static CELL: OnceLock<Mutex<HashMap<String, RateBucket>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn await_rate_limit(provider: &str) {
    loop {
        let wait = {
            let mut map = rate_buckets().lock().expect("rate bucket lock");
            let bucket = map
                .entry(provider.to_string())
                .or_insert_with(RateBucket::new);
            bucket.check()
        };
        if wait.is_zero() {
            return;
        }
        // 注意：用 max 100ms 步长唤醒，避免极端 sleep 把整体延迟堆得很高
        let step = wait.min(Duration::from_millis(500));
        tokio::time::sleep(step).await;
    }
}

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
    // anthropic / google 走专有协议；其余都走 OpenAI 兼容（chat completions）。
    // 已支持：anthropic | openai | google | deepseek | ollama | nvidia | xai |
    //         groq | openrouter | siliconflow | zhipu | dashscope | moonshot |
    //         mistral | together | custom
    pub provider: String,
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
    await_rate_limit(&req.provider).await;
    match req.provider.as_str() {
        "anthropic" => call_anthropic(req).await,
        "google" => call_google(req).await,
        // openai 兼容协议覆盖 openai / deepseek / ollama / custom
        _ => call_openai_compat(req).await,
    }
}

// ─── Agent / Tool-use ────────────────────────────────────────────────
//
// 让 AI 像 Claude Code / Codex 那样自己决定要读哪个文件、grep 什么关键词。
// 一轮调用流程：前端发 (messages + tools) → 后端 POST 给 LLM → 返回 text 或
// tool_calls；如果是 tool_calls，前端执行工具、把结果作为 tool message 追加，
// 再发下一轮。直到收到 text 为止。前端管 loop（持有 workspacePath，能直接调
// 既有的 fs_grep / fs_read_text / fs_read_dir）。
//
// 当前实现：OpenAI 兼容协议（覆盖 openai / deepseek / groq / moonshot / xai /
// nvidia / openrouter / together / mistral / siliconflow / zhipu / dashscope /
// ollama / custom = 14 个 provider）。Anthropic 与 Google 的 tool 协议字段
// 不一样，后续单独实现，先报明确错误避免静默 fallback。

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTool {
    pub name: String,
    pub description: String,
    /// JSON Schema 描述参数。原样转发给上游 LLM。
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolCall {
    pub id: String,
    pub name: String,
    /// 解析过的 JSON 参数；OpenAI 实际传的是 stringified JSON，这里统一成 Value
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "snake_case")]
pub enum AgentMsg {
    User {
        content: String,
    },
    System {
        content: String,
    },
    Assistant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<AgentToolCall>>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub provider: String,
    pub api_key: Option<String>,
    pub endpoint: Option<String>,
    pub model: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system: Option<String>,
    pub messages: Vec<AgentMsg>,
    pub tools: Vec<AgentTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentTurnResult {
    Text {
        text: String,
        model: Option<String>,
        input_tokens: Option<u32>,
        output_tokens: Option<u32>,
    },
    ToolCalls {
        calls: Vec<AgentToolCall>,
        model: Option<String>,
        input_tokens: Option<u32>,
        output_tokens: Option<u32>,
    },
}

pub async fn chat_with_tools(req: AgentRequest) -> Result<AgentTurnResult, String> {
    await_rate_limit(&req.provider).await;
    match req.provider.as_str() {
        "anthropic" => call_anthropic_with_tools(req).await,
        "google" => call_google_with_tools(req).await,
        _ => call_openai_compat_with_tools(req).await,
    }
}

async fn call_openai_compat_with_tools(req: AgentRequest) -> Result<AgentTurnResult, String> {
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| default_openai_compat_endpoint(&req.provider));
    let url = format!("{}/chat/completions", endpoint.trim_end_matches('/'));

    let mut messages: Vec<serde_json::Value> = Vec::new();
    if let Some(sys) = req.system.as_ref() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    for m in req.messages.iter() {
        match m {
            AgentMsg::User { content } => {
                messages.push(serde_json::json!({ "role": "user", "content": content }));
            }
            AgentMsg::System { content } => {
                messages.push(serde_json::json!({ "role": "system", "content": content }));
            }
            AgentMsg::Assistant {
                content,
                tool_calls,
            } => {
                if let Some(calls) = tool_calls {
                    let calls_json: Vec<serde_json::Value> = calls
                        .iter()
                        .map(|c| {
                            let args_str = serde_json::to_string(&c.input)
                                .unwrap_or_else(|_| "{}".to_string());
                            serde_json::json!({
                                "id": c.id,
                                "type": "function",
                                "function": {
                                    "name": c.name,
                                    "arguments": args_str,
                                }
                            })
                        })
                        .collect();
                    // OpenAI 协议：assistant 带 tool_calls 时 content 可以为 null，
                    // 但部分兼容实现要求字段存在；统一传空串。
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": content.clone().unwrap_or_default(),
                        "tool_calls": calls_json,
                    }));
                } else {
                    messages.push(serde_json::json!({
                        "role": "assistant",
                        "content": content.clone().unwrap_or_default(),
                    }));
                }
            }
            AgentMsg::Tool {
                tool_call_id,
                content,
            } => {
                messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content,
                }));
            }
        }
    }

    let tools_json: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })
        })
        .collect();

    let mut payload = serde_json::json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens.unwrap_or(4096),
    });
    if !tools_json.is_empty() {
        payload["tools"] = serde_json::json!(tools_json);
        // auto: 让模型自己决定是否调工具
        payload["tool_choice"] = serde_json::json!("auto");
    }
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

    let choice = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "响应缺少 choices".to_string())?;
    let msg = choice
        .get("message")
        .ok_or_else(|| "响应缺少 message".to_string())?;

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
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    if let Some(tool_calls) = msg.get("tool_calls").and_then(|tc| tc.as_array()) {
        if !tool_calls.is_empty() {
            let calls: Vec<AgentToolCall> = tool_calls
                .iter()
                .filter_map(|tc| {
                    let id = tc.get("id")?.as_str()?.to_string();
                    let f = tc.get("function")?;
                    let name = f.get("name")?.as_str()?.to_string();
                    let args_str = f.get("arguments").and_then(|a| a.as_str()).unwrap_or("{}");
                    let input: serde_json::Value =
                        serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
                    Some(AgentToolCall { id, name, input })
                })
                .collect();
            if !calls.is_empty() {
                return Ok(AgentTurnResult::ToolCalls {
                    calls,
                    model,
                    input_tokens,
                    output_tokens,
                });
            }
        }
    }

    let text = msg
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    Ok(AgentTurnResult::Text {
        text,
        model,
        input_tokens,
        output_tokens,
    })
}

// ─── Anthropic tool-use ──────────────────────────────────────────────
//
// Anthropic Messages API 的 tool 协议：
// - 请求：tools = [{ name, description, input_schema }]
// - assistant 调工具：content = [{ type:"text",text }, { type:"tool_use",id,name,input }]
// - tool 结果：作为 user 消息发回，content = [{ type:"tool_result",tool_use_id,content }]
// - 多个连续的 tool 结果必须合并到同一条 user 消息里，否则违反 alternating 规则。
async fn call_anthropic_with_tools(req: AgentRequest) -> Result<AgentTurnResult, String> {
    let key = req
        .api_key
        .clone()
        .ok_or_else(|| "缺少 API Key，请到 设置 → AI 助手 填上".to_string())?;
    let endpoint = req
        .endpoint
        .clone()
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}/v1/messages", endpoint.trim_end_matches('/'));

    let mut messages: Vec<serde_json::Value> = Vec::new();
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();
    let flush_results =
        |pending: &mut Vec<serde_json::Value>, out: &mut Vec<serde_json::Value>| {
            if !pending.is_empty() {
                let content = std::mem::take(pending);
                out.push(serde_json::json!({ "role": "user", "content": content }));
            }
        };

    for m in req.messages.iter() {
        match m {
            AgentMsg::Tool {
                tool_call_id,
                content,
            } => {
                pending_tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": content,
                }));
            }
            AgentMsg::User { content } => {
                flush_results(&mut pending_tool_results, &mut messages);
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": content,
                }));
            }
            AgentMsg::System { .. } => {
                // Anthropic 把 system 放在 top-level，messages 里跳过
                flush_results(&mut pending_tool_results, &mut messages);
            }
            AgentMsg::Assistant {
                content,
                tool_calls,
            } => {
                flush_results(&mut pending_tool_results, &mut messages);
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = content.as_ref() {
                    if !t.is_empty() {
                        parts.push(serde_json::json!({ "type": "text", "text": t }));
                    }
                }
                if let Some(calls) = tool_calls {
                    for c in calls {
                        parts.push(serde_json::json!({
                            "type": "tool_use",
                            "id": c.id,
                            "name": c.name,
                            "input": c.input,
                        }));
                    }
                }
                if !parts.is_empty() {
                    messages
                        .push(serde_json::json!({ "role": "assistant", "content": parts }));
                }
            }
        }
    }
    flush_results(&mut pending_tool_results, &mut messages);

    let tools_json: Vec<serde_json::Value> = req
        .tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            })
        })
        .collect();

    let mut payload = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "messages": messages,
    });
    if let Some(sys) = req.system.as_ref() {
        payload["system"] = serde_json::json!(sys);
    }
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
    }
    if !tools_json.is_empty() {
        payload["tools"] = serde_json::json!(tools_json);
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

    let model = v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string());
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

    let blocks = v
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| "响应缺少 content".to_string())?;
    let mut texts: Vec<String> = Vec::new();
    let mut calls: Vec<AgentToolCall> = Vec::new();
    for block in blocks {
        let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "text" => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    texts.push(text.to_string());
                }
            }
            "tool_use" => {
                let id = block
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                if !id.is_empty() && !name.is_empty() {
                    calls.push(AgentToolCall { id, name, input });
                }
            }
            _ => {}
        }
    }

    if !calls.is_empty() {
        return Ok(AgentTurnResult::ToolCalls {
            calls,
            model,
            input_tokens,
            output_tokens,
        });
    }
    Ok(AgentTurnResult::Text {
        text: texts.join(""),
        model,
        input_tokens,
        output_tokens,
    })
}

// ─── Google Gemini tool-use ──────────────────────────────────────────
//
// Gemini function calling 的协议：
// - 请求：tools = [{ functionDeclarations: [{ name, description, parameters }] }]
// - model 调工具：parts = [{ functionCall: { name, args } }]
// - 工具结果：作为 user 消息 parts = [{ functionResponse: { name, response } }]
// - Gemini 没有 tool_call_id 概念，本地映射 id→name 把前端传过来的 tool_call_id 翻译回 name
async fn call_google_with_tools(req: AgentRequest) -> Result<AgentTurnResult, String> {
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

    // 先建 id→name 映射，便于 Tool 消息回写 functionResponse 时填 name
    let mut id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for m in req.messages.iter() {
        if let AgentMsg::Assistant {
            tool_calls: Some(calls),
            ..
        } = m
        {
            for c in calls {
                id_to_name.insert(c.id.clone(), c.name.clone());
            }
        }
    }

    let mut contents: Vec<serde_json::Value> = Vec::new();
    let mut pending_responses: Vec<serde_json::Value> = Vec::new();
    let flush_responses =
        |pending: &mut Vec<serde_json::Value>, out: &mut Vec<serde_json::Value>| {
            if !pending.is_empty() {
                let parts = std::mem::take(pending);
                out.push(serde_json::json!({ "role": "user", "parts": parts }));
            }
        };

    for m in req.messages.iter() {
        match m {
            AgentMsg::Tool {
                tool_call_id,
                content,
            } => {
                let name = id_to_name.get(tool_call_id).cloned().unwrap_or_default();
                pending_responses.push(serde_json::json!({
                    "functionResponse": {
                        "name": name,
                        "response": { "content": content },
                    },
                }));
            }
            AgentMsg::User { content } => {
                flush_responses(&mut pending_responses, &mut contents);
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{ "text": content }],
                }));
            }
            AgentMsg::System { .. } => {
                // Gemini 把 system 放 systemInstruction，messages 里跳过
                flush_responses(&mut pending_responses, &mut contents);
            }
            AgentMsg::Assistant {
                content,
                tool_calls,
            } => {
                flush_responses(&mut pending_responses, &mut contents);
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = content.as_ref() {
                    if !t.is_empty() {
                        parts.push(serde_json::json!({ "text": t }));
                    }
                }
                if let Some(calls) = tool_calls {
                    for c in calls {
                        parts.push(serde_json::json!({
                            "functionCall": { "name": c.name, "args": c.input },
                        }));
                    }
                }
                if !parts.is_empty() {
                    contents.push(serde_json::json!({
                        "role": "model",
                        "parts": parts,
                    }));
                }
            }
        }
    }
    flush_responses(&mut pending_responses, &mut contents);

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
    if !req.tools.is_empty() {
        let decls: Vec<serde_json::Value> = req
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                })
            })
            .collect();
        payload["tools"] = serde_json::json!([{ "functionDeclarations": decls }]);
        payload["toolConfig"] = serde_json::json!({
            "functionCallingConfig": { "mode": "AUTO" }
        });
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

    let parts = v
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array());

    let mut texts: Vec<String> = Vec::new();
    let mut calls: Vec<AgentToolCall> = Vec::new();
    if let Some(parts) = parts {
        for (i, p) in parts.iter().enumerate() {
            if let Some(text) = p.get("text").and_then(|t| t.as_str()) {
                texts.push(text.to_string());
            }
            if let Some(fc) = p.get("functionCall") {
                let name = fc
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = fc.get("args").cloned().unwrap_or(serde_json::json!({}));
                if !name.is_empty() {
                    // Gemini 没 ID，合成 "gemini-<name>-<i>" 保证当轮唯一
                    calls.push(AgentToolCall {
                        id: format!("gemini-{}-{}", name, i),
                        name,
                        input: args,
                    });
                }
            }
        }
    }

    if !calls.is_empty() {
        return Ok(AgentTurnResult::ToolCalls {
            calls,
            model: Some(model),
            input_tokens,
            output_tokens,
        });
    }
    Ok(AgentTurnResult::Text {
        text: texts.join(""),
        model: Some(model),
        input_tokens,
        output_tokens,
    })
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
        .unwrap_or_else(|| default_openai_compat_endpoint(&req.provider));
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

/// 走 OpenAI 兼容协议 (chat completions) 的 provider 默认 endpoint。
/// 新增 provider 时改这里 + src/lib/ai-providers.ts，两边保持一致。
fn default_openai_compat_endpoint(provider: &str) -> String {
    match provider {
        "openai" => "https://api.openai.com/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "ollama" => "http://127.0.0.1:11434/v1",
        "nvidia" => "https://integrate.api.nvidia.com/v1",
        "xai" => "https://api.x.ai/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "siliconflow" => "https://api.siliconflow.cn/v1",
        "zhipu" => "https://open.bigmodel.cn/api/paas/v4",
        "dashscope" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "moonshot" => "https://api.moonshot.cn/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "together" => "https://api.together.xyz/v1",
        // custom 或未知 provider 不强行回填，让前端的报错信息更直白
        _ => "https://api.openai.com/v1",
    }
    .to_string()
}

// ─── 模型列表拉取 ────────────────────────────────────────────────
//
// 三套协议：
//   anthropic       → GET {endpoint}/v1/models, x-api-key + anthropic-version
//   google          → GET {endpoint}/v1beta/models?key=..., 过滤 supportedGenerationMethods
//   其余 (OpenAI 兼容) → GET {endpoint}/models, Bearer key
//
// 返回结构里：
//   id            原始模型 id，可直接发给 chat API
//   label         展示名（Anthropic display_name / Google displayName / 聚合站斜杠后段）
//   group         聚合站的 "vendor/model" 前缀分组（无斜杠则 None）
//   context_length 已知则带回（OpenRouter / Google）

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: Option<String>,
    pub group: Option<String>,
    pub context_length: Option<u32>,
}

pub async fn list_models(
    provider: String,
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    match provider.as_str() {
        "anthropic" => list_models_anthropic(endpoint, api_key).await,
        "google" => list_models_google(endpoint, api_key).await,
        _ => list_models_openai_compat(&provider, endpoint, api_key).await,
    }
}

async fn list_models_anthropic(
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    let key = api_key
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "缺少 API Key".to_string())?;
    let endpoint = endpoint
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_string());
    let url = format!("{}/v1/models?limit=1000", endpoint.trim_end_matches('/'));
    let client = http_chat_client();
    let resp = client
        .get(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
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
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "响应缺少 data 数组".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let label = item
            .get("display_name")
            .and_then(|x| x.as_str())
            .map(String::from);
        out.push(ModelInfo {
            id,
            label,
            group: None,
            context_length: None,
        });
    }
    Ok(out)
}

async fn list_models_google(
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    let key = api_key
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "缺少 API Key".to_string())?;
    let endpoint = endpoint
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string());
    let client = http_chat_client();
    let mut all = Vec::new();
    let mut page_token: Option<String> = None;
    // 翻页最多 5 次（200 * 5 = 1000 个上限），防止恶意/异常响应卡住主线程
    for _ in 0..5 {
        let mut url = format!(
            "{}/v1beta/models?pageSize=200&key={}",
            endpoint.trim_end_matches('/'),
            urlencode_val(&key),
        );
        if let Some(tok) = page_token.as_ref() {
            url.push_str(&format!("&pageToken={}", urlencode_val(tok)));
        }
        let resp = client
            .get(&url)
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
        if let Some(arr) = v.get("models").and_then(|m| m.as_array()) {
            for item in arr {
                // 只保留支持 generateContent 的（过滤掉 embedContent / countTokens-only）
                let supports_chat = item
                    .get("supportedGenerationMethods")
                    .and_then(|m| m.as_array())
                    .map(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
                    .unwrap_or(false);
                if !supports_chat {
                    continue;
                }
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("");
                let id = name.strip_prefix("models/").unwrap_or(name).to_string();
                if id.is_empty() {
                    continue;
                }
                let label = item
                    .get("displayName")
                    .and_then(|x| x.as_str())
                    .map(String::from);
                let context_length = item
                    .get("inputTokenLimit")
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32);
                all.push(ModelInfo {
                    id,
                    label,
                    group: None,
                    context_length,
                });
            }
        }
        page_token = v
            .get("nextPageToken")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        if page_token.is_none() {
            break;
        }
    }
    Ok(all)
}

async fn list_models_openai_compat(
    provider: &str,
    endpoint: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, String> {
    let endpoint = endpoint
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_openai_compat_endpoint(provider));
    if endpoint.is_empty() {
        return Err("请先填 Endpoint".to_string());
    }
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    let client = http_chat_client();
    let mut builder = client.get(&url);
    if let Some(k) = api_key.as_ref() {
        if !k.is_empty() {
            builder = builder.bearer_auth(k);
        }
    }
    let resp = builder.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("API {}: {}", status, truncate(&body, 400)));
    }
    parse_openai_models_payload(&body)
}

/// 提出来便于单测。OpenAI / DeepSeek / Groq / OpenRouter / SiliconFlow / NVIDIA NIM
/// 都遵循 `{ data: [{ id, ... }] }` 这套；额外字段是各家自己加的，能解析就解析，
/// 不能就回退到 id-only。
fn parse_openai_models_payload(body: &str) -> Result<Vec<ModelInfo>, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("解析响应失败：{e}"))?;
    // Ollama 自家 /api/tags 是 { models: [...] }，但 /v1/models 走 OpenAI 兼容
    // 也是 { data: [...] }，所以这里只看 data。
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "响应缺少 data 数组".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        // 聚合站常用 "vendor/model" 形式，自然分组
        let (group, label) = match id.split_once('/') {
            Some((g, l)) => (Some(g.to_string()), Some(l.to_string())),
            None => (None, None),
        };
        // OpenRouter: { context_length: 200000, top_provider: { context_length: ... } }
        let context_length = item
            .get("context_length")
            .and_then(|n| n.as_u64())
            .or_else(|| {
                item.get("top_provider")
                    .and_then(|t| t.get("context_length"))
                    .and_then(|n| n.as_u64())
            })
            .map(|n| n as u32);
        out.push(ModelInfo {
            id,
            label,
            group,
            context_length,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod list_models_tests {
    use super::*;

    #[test]
    fn parses_openai_data_payload() {
        let body = r#"{
            "object": "list",
            "data": [
                { "id": "gpt-4o-mini", "object": "model" },
                { "id": "gpt-4o", "object": "model" }
            ]
        }"#;
        let list = parse_openai_models_payload(body).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "gpt-4o-mini");
        assert!(list[0].group.is_none());
    }

    #[test]
    fn parses_openrouter_payload_with_groups_and_ctx() {
        let body = r#"{
            "data": [
                { "id": "anthropic/claude-3.5-sonnet", "context_length": 200000 },
                { "id": "openai/gpt-4o-mini", "top_provider": { "context_length": 128000 } },
                { "id": "meta-llama/llama-3.3-70b-instruct" }
            ]
        }"#;
        let list = parse_openai_models_payload(body).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].group.as_deref(), Some("anthropic"));
        assert_eq!(list[0].label.as_deref(), Some("claude-3.5-sonnet"));
        assert_eq!(list[0].context_length, Some(200000));
        assert_eq!(list[1].context_length, Some(128000));
        assert_eq!(list[2].group.as_deref(), Some("meta-llama"));
    }

    #[test]
    fn rejects_missing_data_array() {
        let body = r#"{ "object": "list" }"#;
        let err = parse_openai_models_payload(body).unwrap_err();
        assert!(err.contains("data"));
    }

    #[test]
    fn skips_blank_ids() {
        let body = r#"{ "data": [ { "id": "" }, { "id": "ok" } ] }"#;
        let list = parse_openai_models_payload(body).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "ok");
    }
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
    await_rate_limit(&req.provider).await;
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
        .unwrap_or_else(|| default_openai_compat_endpoint(&req.provider));
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
