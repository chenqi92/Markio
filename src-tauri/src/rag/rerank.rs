// RAG 重排（Reranker）
//
// 当前只实现「Cohere 兼容」一种 provider —— 大多数 reranker 服务（Cohere、
// infinity-emb、TEI 的 /rerank 接口）都遵循同一份请求/响应 schema：
//
//   POST {base_url}/v1/rerank
//   Bearer auth
//   { model, query, documents: [...], top_n }
//   → { results: [{ index, relevance_score }] }
//
// Ollama 暂无官方 rerank endpoint；如果用户用 ollama 跑 reranker，建议在外面
// 套一层 infinity-emb 或类似服务，再用本 provider 调过去。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankConfig {
    /// 当前只支持 "cohere"（Cohere 官方 + 任何 cohere-compat 服务）
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct CohereDoc<'a> {
    text: &'a str,
}

#[derive(Debug, Serialize)]
struct CohereReq<'a> {
    model: &'a str,
    query: &'a str,
    documents: Vec<CohereDoc<'a>>,
    top_n: usize,
    return_documents: bool,
}

#[derive(Debug, Deserialize)]
struct CohereResultItem {
    index: usize,
    relevance_score: f32,
}

#[derive(Debug, Deserialize)]
struct CohereResp {
    results: Vec<CohereResultItem>,
}

/// 同步阻塞调用；search.rs 在 spawn_blocking 上下文里跑。
/// 失败时返回原始顺序的 (index, score=0)，让上层无感降级。
pub fn rerank_blocking(
    cfg: &RerankConfig,
    query: &str,
    documents: &[String],
    top_n: usize,
) -> Result<Vec<(usize, f32)>, String> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    if cfg.provider != "cohere" {
        return Err(format!(
            "不支持的 reranker provider: {}（当前仅支持 cohere 兼容协议）",
            cfg.provider
        ));
    }
    let base = cfg
        .base_url
        .clone()
        .unwrap_or_else(|| "https://api.cohere.com".to_string());
    let url = format!("{}/v1/rerank", base.trim_end_matches('/'));
    let body = CohereReq {
        model: &cfg.model,
        query,
        documents: documents.iter().map(|d| CohereDoc { text: d }).collect(),
        top_n: top_n.min(documents.len()),
        return_documents: false,
    };

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("rerank runtime: {e}"))?;
    rt.block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let mut builder = client.post(&url).header("content-type", "application/json");
        if let Some(k) = cfg.api_key.as_ref().filter(|s| !s.is_empty()) {
            builder = builder.bearer_auth(k);
        }
        let resp = builder
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("rerank 请求失败：{e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "rerank API {}: {}",
                status,
                text.chars().take(400).collect::<String>()
            ));
        }
        let parsed: CohereResp =
            serde_json::from_str(&text).map_err(|e| format!("解析 rerank 响应失败：{e}"))?;
        let mut out: Vec<(usize, f32)> = parsed
            .results
            .into_iter()
            .map(|r| (r.index, r.relevance_score))
            .collect();
        // 按 score 倒序
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        Ok(out)
    })
}
