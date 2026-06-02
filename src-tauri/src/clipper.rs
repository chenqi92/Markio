//! WebClipper loopback HTTP server。
//!
//! 浏览器扩展把当前网页 / 选区的 HTML POST 过来，转成 Markdown 落到仓库的 `Clipped/` 目录。
//!
//! 安全模型同 mcp.rs：
//! - 只 bind 127.0.0.1（loopback），不开外网
//! - `POST /clip` 需 `Authorization: Bearer <token>`，token 启动时随机生成
//! - 写入路径仍过仓库 allowlist（落在已注册 workspace 内）
//! - `GET /clip/health` 不鉴权，供扩展「测试连接」探活（不泄露内容）

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;

use crate::state::AppState;

/// 全局可见的 WebClipper 端口 / token / 配置（前端可读可写）。
#[derive(Default)]
pub struct ClipperRuntime {
    inner: RwLock<Inner>,
}

#[derive(Clone)]
struct Inner {
    port: Option<u16>,
    token: Option<String>,
    enabled: bool,
    readability: bool,
    html_to_md: bool,
    ai_summary: bool,
    active_workspace: Option<PathBuf>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            port: None,
            token: None,
            enabled: false,
            readability: true,
            html_to_md: true,
            ai_summary: false,
            active_workspace: None,
        }
    }
}

#[derive(Clone)]
pub struct ClipperStatus {
    pub port: Option<u16>,
    pub token: Option<String>,
    pub enabled: bool,
}

impl ClipperRuntime {
    pub fn status(&self) -> ClipperStatus {
        let g = self.inner.read().unwrap();
        ClipperStatus {
            port: g.port,
            token: g.token.clone(),
            enabled: g.enabled,
        }
    }

    pub fn set_config(&self, enabled: bool, readability: bool, html_to_md: bool, ai_summary: bool) {
        let mut g = self.inner.write().unwrap();
        g.enabled = enabled;
        g.readability = readability;
        g.html_to_md = html_to_md;
        g.ai_summary = ai_summary;
    }

    pub fn set_active_workspace(&self, p: Option<PathBuf>) {
        self.inner.write().unwrap().active_workspace = p;
    }

    fn set_started(&self, port: u16, token: String) {
        let mut g = self.inner.write().unwrap();
        g.port = Some(port);
        g.token = Some(token);
    }

    fn snapshot(&self) -> Inner {
        self.inner.read().unwrap().clone()
    }
}

#[derive(Clone)]
struct ServerState {
    app: AppHandle,
    runtime: Arc<ClipperRuntime>,
}

/// 在后台启动 WebClipper server。失败仅打日志，不让 app crash。
pub fn spawn(app: AppHandle, runtime: Arc<ClipperRuntime>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(app, runtime).await {
            eprintln!("[clipper] server 启动失败：{e}");
        }
    });
}

async fn run(app: AppHandle, runtime: Arc<ClipperRuntime>) -> Result<(), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind 失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = crate::random_loopback_token();
    runtime.set_started(port, token);

    let state = ServerState {
        app,
        runtime: runtime.clone(),
    };
    let router = Router::new()
        .route("/clip/health", get(health))
        .route("/clip", post(clip))
        .with_state(state);

    eprintln!("[clipper] listening on http://127.0.0.1:{port}");
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("axum serve: {e}"))
}

fn check_token(headers: &HeaderMap, expected: &Option<String>) -> Result<(), (StatusCode, String)> {
    let Some(want) = expected else {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "WebClipper 尚未就绪".into()));
    };
    let got = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if got != want {
        return Err((StatusCode::UNAUTHORIZED, "无效 token".into()));
    }
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "markio-clipper" }))
}

#[derive(Deserialize)]
struct ClipReq {
    url: Option<String>,
    title: Option<String>,
    html: String,
    #[serde(default)]
    selection: bool,
}

#[derive(Serialize)]
struct ClipResp {
    ok: bool,
    path: String,
}

async fn clip(
    State(s): State<ServerState>,
    headers: HeaderMap,
    Json(req): Json<ClipReq>,
) -> Result<Json<ClipResp>, (StatusCode, String)> {
    let cfg = s.runtime.snapshot();
    check_token(&headers, &cfg.token)?;
    if !cfg.enabled {
        return Err((StatusCode::FORBIDDEN, "WebClipper 未启用".into()));
    }
    if req.html.len() > 8 * 1024 * 1024 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "剪藏内容过大（>8MB）".into()));
    }
    let ws = resolve_workspace(&s.app, cfg.active_workspace.as_ref())?;

    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("未命名剪藏")
        .to_string();
    let url = req.url.clone().unwrap_or_default();

    // html → markdown（或保留原始 html）
    let body = if cfg.html_to_md {
        crate::html2md::html_to_markdown(&req.html, cfg.readability)
    } else {
        format!("```html\n{}\n```", req.html)
    };

    let now = chrono::Local::now();
    let frontmatter = build_frontmatter(&title, &url, &now.to_rfc3339(), req.selection);
    let content = format!("{frontmatter}\n# {}\n\n{body}\n", yaml_inline_safe_heading(&title));

    let stamp = now.format("%Y%m%d-%H%M%S").to_string();
    let fname = format!("{}-{stamp}.md", sanitize_filename(&title));
    let dest = ws.join("Clipped").join(fname);

    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::fs_ops::atomic_write(&dest2, &content)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let path_str = dest.to_string_lossy().to_string();

    // AI 摘要：Rust 不持有 AI provider 配置，派发事件给前端生成后经 clipper_set_summary 回写。
    if cfg.ai_summary {
        let text: String = body.chars().take(4000).collect();
        let _ = s.app.emit(
            "clip-summarize",
            serde_json::json!({ "path": path_str, "title": title, "text": text }),
        );
    }

    Ok(Json(ClipResp {
        ok: true,
        path: path_str,
    }))
}

/// 把 AI 摘要写进剪藏文件的 frontmatter：若已有 `summary:` 行则替换，否则在闭合 `---` 前插入。
pub(crate) fn insert_summary(content: &str, summary: &str) -> String {
    let quoted = yaml_quote(summary);
    // 找 frontmatter 块：以 "---\n" 开头，到下一行 "---"
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(close_rel) = rest.find("\n---") {
            let fm_body = &rest[..close_rel];
            let after = &rest[close_rel..]; // 从 "\n---" 开始
            let mut lines: Vec<String> = fm_body.lines().map(|l| l.to_string()).collect();
            let mut replaced = false;
            for line in lines.iter_mut() {
                if line.trim_start().starts_with("summary:") {
                    *line = format!("summary: {quoted}");
                    replaced = true;
                    break;
                }
            }
            if !replaced {
                lines.push(format!("summary: {quoted}"));
            }
            return format!("---\n{}{}", lines.join("\n"), after);
        }
    }
    // 无 frontmatter：在最前面补一段
    format!("---\nsummary: {quoted}\n---\n\n{content}")
}

fn resolve_workspace(
    app: &AppHandle,
    active: Option<&PathBuf>,
) -> Result<PathBuf, (StatusCode, String)> {
    let app_state = app.state::<AppState>();
    let inner = app_state
        .inner
        .lock()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(p) = active {
        if inner.workspaces.contains(p) {
            return Ok(p.clone());
        }
    }
    if inner.workspaces.len() == 1 {
        return Ok(inner.workspaces.iter().next().unwrap().clone());
    }
    Err((
        StatusCode::BAD_REQUEST,
        "没有活跃仓库，请在 markio 里打开一个仓库后再剪藏".into(),
    ))
}

/// 文件名安全化：去掉路径分隔符与控制字符，截断到合理长度。
fn sanitize_filename(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    for ch in title.chars() {
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => {
                out.push('-')
            }
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    let trimmed = out.trim().trim_matches('.').trim();
    let capped: String = trimmed.chars().take(80).collect();
    let capped = capped.trim().to_string();
    if capped.is_empty() {
        "clip".to_string()
    } else {
        capped
    }
}

/// 防止标题里的换行/控制字符破坏 markdown 标题行。
fn yaml_inline_safe_heading(title: &str) -> String {
    title.replace(['\n', '\r'], " ")
}

fn build_frontmatter(title: &str, url: &str, date: &str, selection: bool) -> String {
    let mut fm = String::from("---\n");
    fm.push_str(&format!("title: {}\n", yaml_quote(title)));
    if !url.is_empty() {
        fm.push_str(&format!("source: {}\n", yaml_quote(url)));
    }
    fm.push_str(&format!("clipped: {}\n", yaml_quote(date)));
    fm.push_str(&format!("clip_kind: {}\n", if selection { "selection" } else { "page" }));
    fm.push_str("---\n");
    fm
}

/// YAML 双引号字符串：转义反斜杠与双引号，换行折成空格。
fn yaml_quote(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\n', '\r'], " ");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_path_separators() {
        assert_eq!(sanitize_filename("a/b:c*d?"), "a-b-c-d-");
        assert_eq!(sanitize_filename("  "), "clip");
        assert_eq!(sanitize_filename("正常标题"), "正常标题");
    }

    #[test]
    fn yaml_quote_escapes() {
        assert_eq!(yaml_quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(yaml_quote("line1\nline2"), "\"line1 line2\"");
    }

    #[test]
    fn insert_summary_into_existing_frontmatter() {
        let src = "---\ntitle: \"x\"\nclipped: \"t\"\n---\n# x\n\nbody";
        let out = insert_summary(src, "一句话摘要");
        assert!(out.contains("summary: \"一句话摘要\""));
        assert!(out.contains("title: \"x\""));
        assert!(out.contains("# x"));
        // 再次插入应替换而非重复
        let out2 = insert_summary(&out, "新摘要");
        assert_eq!(out2.matches("summary:").count(), 1);
        assert!(out2.contains("summary: \"新摘要\""));
    }

    #[test]
    fn insert_summary_without_frontmatter() {
        let out = insert_summary("just body", "摘要");
        assert!(out.starts_with("---\nsummary: \"摘要\"\n---\n"));
        assert!(out.contains("just body"));
    }

    #[test]
    fn frontmatter_includes_fields() {
        let fm = build_frontmatter("标题", "https://x.com", "2026-06-02T00:00:00+08:00", true);
        assert!(fm.contains("title: \"标题\""));
        assert!(fm.contains("source: \"https://x.com\""));
        assert!(fm.contains("clip_kind: selection"));
    }
}
