use serde::{Deserialize, Serialize};

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
        payload["systemInstruction"] =
            serde_json::json!({ "parts": [{ "text": sys }] });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
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
            _ => out.push_str(&format!("%{:02X}", b)),
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
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
        return Err(format!("Anthropic API {}: {}", status, truncate(&body, 400)));
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
        model: v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
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
        model: v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
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
