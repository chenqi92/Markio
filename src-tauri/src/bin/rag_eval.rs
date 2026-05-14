//! RAG 评估 CLI · recall@K / MRR
//!
//! 用法：
//!   cargo run --bin rag_eval -- \
//!     --workspace /path/to/indexed/workspace \
//!     --fixture ../tests/rag-fixtures/sample.json \
//!     --k 10 \
//!     --provider ollama --model nomic-embed-text --dim 768 \
//!     [--api-key ...] [--base-url http://localhost:11434]
//!
//! 不会重建索引：workspace 必须已经索引过；否则结果都是 0。

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

use markio_lib::rag;

#[derive(Deserialize)]
struct Fixture {
    query: String,
    expected: Vec<String>,
}

#[derive(Deserialize)]
struct FixtureFile {
    fixtures: Vec<Fixture>,
}

struct Args {
    workspace: PathBuf,
    fixture: PathBuf,
    k: usize,
    provider: String,
    model: String,
    dim: usize,
    base_url: Option<String>,
    api_key: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut workspace: Option<PathBuf> = None;
    let mut fixture: Option<PathBuf> = None;
    let mut k = 10usize;
    let mut provider = "ollama".to_string();
    let mut model = "nomic-embed-text".to_string();
    let mut dim = 768usize;
    let mut base_url: Option<String> = None;
    let mut api_key: Option<String> = None;

    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let take = |it: &mut std::iter::Skip<std::env::Args>, flag: &str| {
            it.next().ok_or_else(|| format!("缺少 {flag} 的值"))
        };
        match flag.as_str() {
            "--workspace" | "-w" => workspace = Some(PathBuf::from(take(&mut it, &flag)?)),
            "--fixture" | "-f" => fixture = Some(PathBuf::from(take(&mut it, &flag)?)),
            "--k" => {
                k = take(&mut it, &flag)?
                    .parse()
                    .map_err(|e| format!("--k 不是合法整数：{e}"))?
            }
            "--provider" => provider = take(&mut it, &flag)?,
            "--model" => model = take(&mut it, &flag)?,
            "--dim" => {
                dim = take(&mut it, &flag)?
                    .parse()
                    .map_err(|e| format!("--dim 不是合法整数：{e}"))?
            }
            "--base-url" => base_url = Some(take(&mut it, &flag)?),
            "--api-key" => api_key = Some(take(&mut it, &flag)?),
            "--help" | "-h" => {
                println!("{}", include_str!("rag_eval_usage.txt"));
                std::process::exit(0);
            }
            _ => return Err(format!("未知参数：{flag}")),
        }
    }

    Ok(Args {
        workspace: workspace.ok_or("缺少 --workspace")?,
        fixture: fixture.ok_or("缺少 --fixture")?,
        k,
        provider,
        model,
        dim,
        base_url,
        api_key,
    })
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("参数错误：{e}\n用 --help 看用法");
            std::process::exit(2);
        }
    };

    let raw = match std::fs::read_to_string(&args.fixture) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("读取 fixture 失败：{e}");
            std::process::exit(1);
        }
    };
    let parsed: FixtureFile = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("解析 fixture JSON 失败：{e}");
            std::process::exit(1);
        }
    };

    let provider_enum = match rag::embed::Provider::parse(&args.provider) {
        Some(p) => p,
        None => {
            eprintln!("未知 provider：{}", args.provider);
            std::process::exit(2);
        }
    };
    let cfg = rag::embed::EmbedConfig {
        provider: provider_enum,
        model: args.model.clone(),
        base_url: args.base_url.clone(),
        api_key: args.api_key.clone(),
    };

    let ws_str = args.workspace.to_string_lossy().to_string();
    let handle = match rag::rag_handle(&ws_str, args.dim) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("打开 workspace 索引失败：{e}");
            std::process::exit(1);
        }
    };

    let mut totals = EvalTotals::default();
    let mut per_query: Vec<(String, EvalRow)> = Vec::new();
    for fx in &parsed.fixtures {
        let hits = match rag::search::search(handle.clone(), cfg.clone(), &fx.query, args.k, true) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[query={}] 检索失败：{e}", fx.query);
                continue;
            }
        };
        let row = score_query(&fx.expected, &hits);
        totals.recall_sum += row.recall;
        totals.rr_sum += row.reciprocal_rank;
        totals.count += 1;
        per_query.push((fx.query.clone(), row));
    }

    println!("===== RAG eval =====");
    println!("workspace: {}", ws_str);
    println!("fixture:   {}", args.fixture.display());
    println!("k:         {}", args.k);
    println!("provider:  {} / {}", args.provider, args.model);
    println!();
    println!("query                                            recall@K   RR");
    for (q, row) in &per_query {
        let q_trim: String = q.chars().take(48).collect();
        println!(
            "{:<48}  {:>6.3}   {:>5.3}",
            q_trim, row.recall, row.reciprocal_rank
        );
    }
    if totals.count > 0 {
        println!();
        println!(
            "mean recall@{}: {:.3}",
            args.k,
            totals.recall_sum / totals.count as f64
        );
        println!("MRR:           {:.3}", totals.rr_sum / totals.count as f64);
    } else {
        println!("没有任何 query 跑完。");
        std::process::exit(1);
    }
}

#[derive(Default)]
struct EvalTotals {
    recall_sum: f64,
    rr_sum: f64,
    count: usize,
}

struct EvalRow {
    recall: f64,
    reciprocal_rank: f64,
}

fn score_query(expected: &[String], hits: &[rag::SearchHit]) -> EvalRow {
    if expected.is_empty() {
        return EvalRow {
            recall: 0.0,
            reciprocal_rank: 0.0,
        };
    }
    let exp: HashMap<&str, ()> = expected.iter().map(|s| (s.as_str(), ())).collect();
    let mut found = 0usize;
    let mut first_rank: Option<usize> = None;
    for (i, h) in hits.iter().enumerate() {
        // 命中规则：path 以 expected 字符串结尾（相对路径匹配）
        let matched = exp.keys().any(|e| h.path.replace('\\', "/").ends_with(*e));
        if matched {
            found += 1;
            if first_rank.is_none() {
                first_rank = Some(i + 1);
            }
        }
    }
    let recall = found as f64 / expected.len() as f64;
    let reciprocal_rank = first_rank.map(|r| 1.0 / r as f64).unwrap_or(0.0);
    EvalRow {
        recall,
        reciprocal_rank,
    }
}
