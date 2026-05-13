//! Embedding 提供方抽象。
//!
//! 支持两种后端：
//! - `Ollama`：本地 `http://127.0.0.1:11434/api/embed`，免费离线，零审核风险（推荐）
//! - `OpenAI-compat`：含 OpenAI 官方 / 兼容 API（Voyage / DeepSeek 等）
//!
//! 不直接读 secret store —— 调用方在拉起前自行把 API Key 通过 secrets 拿出来。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Ollama,
    OpenAi,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Ollama => "ollama",
            Provider::OpenAi => "openai",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ollama" => Some(Provider::Ollama),
            "openai" => Some(Provider::OpenAi),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedConfig {
    pub provider: Provider,
    pub model: String,
    /// Ollama：默认 http://127.0.0.1:11434；OpenAI：默认 https://api.openai.com
    pub base_url: Option<String>,
    /// OpenAI 必填；Ollama 一般不需要
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EmbedResult {
    pub vectors: Vec<Vec<f32>>,
    pub dim: usize,
}

/// 同步入口（内部起 runtime）。给后台索引任务用，避免把整个 indexer 都 async 化。
pub fn embed_blocking(cfg: &EmbedConfig, inputs: &[String]) -> Result<EmbedResult, String> {
    let inputs = inputs.to_vec();
    let cfg = cfg.clone();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("无法创建 tokio runtime：{e}"))?;
    rt.block_on(embed(&cfg, &inputs))
}

pub async fn embed(cfg: &EmbedConfig, inputs: &[String]) -> Result<EmbedResult, String> {
    if inputs.is_empty() {
        return Ok(EmbedResult {
            vectors: vec![],
            dim: 0,
        });
    }
    match cfg.provider {
        Provider::Ollama => call_ollama(cfg, inputs).await,
        Provider::OpenAi => call_openai(cfg, inputs).await,
    }
}

async fn call_ollama(cfg: &EmbedConfig, inputs: &[String]) -> Result<EmbedResult, String> {
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "http://127.0.0.1:11434".to_string());
    let endpoint = format!("{}/api/embed", base.trim_end_matches('/'));

    let payload = serde_json::json!({
        "model": cfg.model,
        "input": inputs,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("初始化 reqwest 失败：{e}"))?;
    let resp = client
        .post(&endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!(
                    "无法连接 Ollama（{base}）。请先安装 Ollama 并运行 `ollama serve`，并 `ollama pull {}`",
                    cfg.model
                )
            } else {
                format!("请求 Ollama 失败：{e}")
            }
        })?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 Ollama 响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("Ollama API {}: {}", status, truncate(&body, 400)));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 Ollama 响应失败：{e}"))?;
    let arr = v
        .get("embeddings")
        .and_then(|x| x.as_array())
        .ok_or_else(|| format!("Ollama 响应缺 embeddings：{}", truncate(&body, 200)))?;
    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(arr.len());
    let mut dim = 0usize;
    for item in arr {
        let arr2 = item
            .as_array()
            .ok_or_else(|| "Ollama embeddings 子项不是数组".to_string())?;
        let vec: Vec<f32> = arr2
            .iter()
            .filter_map(|x| x.as_f64().map(|f| f as f32))
            .collect();
        if dim == 0 {
            dim = vec.len();
        }
        vectors.push(vec);
    }
    Ok(EmbedResult { vectors, dim })
}

async fn call_openai(cfg: &EmbedConfig, inputs: &[String]) -> Result<EmbedResult, String> {
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "https://api.openai.com".to_string());
    let endpoint = format!("{}/v1/embeddings", base.trim_end_matches('/'));
    let api_key = cfg
        .api_key
        .as_deref()
        .ok_or_else(|| "OpenAI Embedding 需要 API Key，请在设置里配置".to_string())?;

    let payload = serde_json::json!({
        "model": cfg.model,
        "input": inputs,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("初始化 reqwest 失败：{e}"))?;
    let resp = client
        .post(&endpoint)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求云端 Embedding 失败：{e}"))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取 Embedding 响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Embedding API {}: {}",
            status,
            truncate(&body, 400)
        ));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 Embedding 响应失败：{e}"))?;
    let arr = v
        .get("data")
        .and_then(|x| x.as_array())
        .ok_or_else(|| format!("Embedding 响应缺 data：{}", truncate(&body, 200)))?;
    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(arr.len());
    let mut dim = 0usize;
    for item in arr {
        let arr2 = item
            .get("embedding")
            .and_then(|x| x.as_array())
            .ok_or_else(|| "Embedding 响应子项缺 embedding 字段".to_string())?;
        let vec: Vec<f32> = arr2
            .iter()
            .filter_map(|x| x.as_f64().map(|f| f as f32))
            .collect();
        if dim == 0 {
            dim = vec.len();
        }
        vectors.push(vec);
    }
    Ok(EmbedResult { vectors, dim })
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut t = s.chars().take(n).collect::<String>();
        t.push('…');
        t
    }
}
