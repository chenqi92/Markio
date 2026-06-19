//! Markio 超轻量 markdown 预览器。
//!
//! 用法：`markio-preview <file.md>`
//! - 复用 `markio-render` 渲染核心（pulldown-cmark + syntect），本地图片内联为 data URI；
//! - 自动发现该文件所在目录下的全部 .md 并在顶部列出，可点击 / ←→ / j k 前后切换；
//! - `--dump <file.md>` 仅输出整页 HTML 到 stdout（无窗口，便于测试 / 调试）。
//!
//! 单实例转发（已有窗口时复用并切到新文件）在后续步骤接入。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

use serde::Serialize;
use single_instance::SingleInstance;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

const SHELL_CSS: &str = include_str!("shell.css");
const SHELL_JS: &str = include_str!("shell.js");

/// 参与"目录发现"的扩展名，与主 app 文件关联保持一致。
const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "txt"];

#[derive(Debug)]
enum UserEvent {
    /// webview 通过 window.ipc.postMessage 发来的 JSON 字符串
    Ipc(String),
    /// 另一个进程通过单实例 socket 转发来的"打开此文件"请求
    Open(PathBuf),
}

/// 单实例锁标识。
/// - Windows：命名互斥量，用普通名字即可（per-session 全局）。
/// - unix：`single-instance` 把 name 当作锁**文件路径**，必须给临时目录下的绝对路径，
///   否则会在当前工作目录建锁文件——从不同目录启动就拿到不同锁、单实例失效且污染目录。
fn singleton_name() -> String {
    #[cfg(windows)]
    {
        "markio-preview-singleton".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
            .join("markio-preview-singleton.lock")
            .to_string_lossy()
            .into_owned()
    }
}

/// 排障日志：仅当临时目录存在 `markio-preview.debug` 标记文件时写入
/// `markio-preview.log`。便于 `open -a` 这类无法接管 stdout 的启动路径下定位问题。
fn dbg_log(msg: &str) {
    let dir = std::env::temp_dir();
    if !dir.join("markio-preview.debug").exists() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("markio-preview.log"))
    {
        let _ = writeln!(f, "[{}] {msg}", std::process::id());
    }
}

/// 端口交接文件：primary 监听随机端口后把端口写在这里，secondary 读出来连接。
fn port_file() -> PathBuf {
    let who = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "anon".into());
    std::env::temp_dir().join(format!("markio-preview-{who}.port"))
}

/// secondary 进程：把目标路径转发给已运行的 primary。成功返回 true。
fn forward_to_primary(target: &Path) -> bool {
    let port: u16 = match std::fs::read_to_string(port_file())
        .ok()
        .and_then(|s| s.trim().parse().ok())
    {
        Some(p) => p,
        None => return false,
    };
    let abs = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    match TcpStream::connect(("127.0.0.1", port)) {
        Ok(mut s) => s.write_all(abs.to_string_lossy().as_bytes()).is_ok(),
        Err(_) => false,
    }
}

/// primary 进程：监听 127.0.0.1 随机端口，收到路径就经 proxy 投递 Open 事件。
fn spawn_listener(proxy: tao::event_loop::EventLoopProxy<UserEvent>) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Ok(addr) = listener.local_addr() {
        let _ = std::fs::write(port_file(), addr.port().to_string());
    }
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            // 读超时：避免某个连上却不发 EOF 的本地客户端把串行 accept 永久卡死、
            // 之后所有正常 secondary 的转发都进不来。
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
            let mut buf = String::new();
            if s.read_to_string(&mut buf).is_ok() {
                let p = buf.trim();
                if !p.is_empty() {
                    let _ = proxy.send_event(UserEvent::Open(PathBuf::from(p)));
                }
            }
        }
    });
}

#[derive(Serialize)]
struct DocPayload {
    title: String,
    bar: String,
    body: String,
}

fn is_md(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .map(|e| MD_EXTS.contains(&e.as_str()))
        .unwrap_or(false)
}

fn file_title(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Markio Preview")
        .to_string()
}

fn name_key(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// 列出目标文件所在目录下的全部 markdown 文件（按文件名不区分大小写排序），
/// 并返回目标文件在列表中的下标。保证目标文件一定在列表里。
fn discover(target: &Path) -> (Vec<PathBuf>, usize) {
    // 裸文件名（如 `markio-preview foo.md`）的 parent() 是 Some("")，不是 None；
    // 空路径会让 read_dir("") 直接 NotFound，故空也要回退到当前目录。
    let dir = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let target_canon = target.canonicalize().ok();
    let same = |p: &Path| match (&target_canon, p.canonicalize().ok()) {
        (Some(t), Some(c)) => &c == t,
        _ => p == target,
    };
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_md(p))
        .collect();
    // 目标必须可定位：read_dir 失败、或目标扩展名不在 MD_EXTS（如直接传 .mdx）时，
    // 它不会出现在列表里，position 会退化到 idx=0 显示错文件——这里兜底补进去。
    if !files.iter().any(|p| same(p)) {
        files.push(target.to_path_buf());
    }
    files.sort_by_key(|p| name_key(p));
    let idx = files.iter().position(|p| same(p)).unwrap_or(0);
    (files, idx)
}

/// 读源文件：优先 UTF-8，失败时退回 lossy（v1 不做完整编码侦测）。
fn read_source(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => format!("> 无法读取文件：{e}"),
    }
}

/// 渲染单个文件正文（body innerHTML）。`base_path` / `allowed_roots` 取文件所在目录，
/// 这样同目录下的本地图片会被内联成 data URI（独立 app 无沙盒限制）。
fn render_body(path: &Path) -> String {
    let src = read_source(path);
    let dir = path.parent().map(|d| d.to_path_buf());
    // allowed_roots 必须 canonicalize：渲染核心会先 canonicalize 图片路径再 starts_with
    // 比对，root 不规范化则同目录本地图片匹配失败、不被内联（与主 app 行为对齐）。
    let roots: Vec<PathBuf> = dir
        .as_deref()
        .and_then(|d| d.canonicalize().ok())
        .into_iter()
        .collect();
    markio_render::render(&src, dir.as_deref(), &roots).html
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 顶部文件条 HTML。
fn bar_html(files: &[PathBuf], idx: usize) -> String {
    let mut s = String::new();
    for (i, p) in files.iter().enumerate() {
        let name = esc(p.file_name().and_then(|x| x.to_str()).unwrap_or("?"));
        let active = if i == idx { " active" } else { "" };
        s.push_str(&format!(
            "<button class=\"tab{active}\" data-idx=\"{i}\" title=\"{name}\">{name}</button>"
        ));
    }
    s.push_str(&format!(
        "<span class=\"count\">{}/{}</span>",
        idx + 1,
        files.len()
    ));
    s
}

/// syntect 主题 → CSS（与渲染核心同 ClassStyle::Spaced），亮色 + 暗色随系统。
fn syntect_css() -> String {
    use syntect::highlighting::ThemeSet;
    use syntect::html::{css_for_theme_with_class_style, ClassStyle};
    let ts = ThemeSet::load_defaults();
    let gen = |name: &str| -> String {
        ts.themes
            .get(name)
            .and_then(|t| css_for_theme_with_class_style(t, ClassStyle::Spaced).ok())
            .unwrap_or_default()
    };
    let light = gen("InspiredGitHub");
    let dark = gen("base16-ocean.dark");
    format!("{light}\n@media (prefers-color-scheme: dark) {{\n{dark}\n}}")
}

/// 整页 HTML（首屏直接内嵌第一篇文档，避免空白闪烁）。
fn full_page(files: &[PathBuf], idx: usize) -> String {
    let (title, body, bar) = if files.is_empty() {
        (
            "Markio Preview".to_string(),
            "<div id=\"empty\">未找到可预览的 Markdown 文件</div>".to_string(),
            String::new(),
        )
    } else {
        (
            file_title(&files[idx]),
            render_body(&files[idx]),
            bar_html(files, idx),
        )
    };
    format!(
        "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{title}</title><style>{SHELL_CSS}\n{syntect}</style></head>\
<body><div id=\"bar\">{bar}</div><div id=\"content\">{body}</div>\
<script>{SHELL_JS}</script></body></html>",
        title = esc(&title),
        syntect = syntect_css(),
    )
}

/// 解析命令行：跳过 flag，取第一个存在的 markdown 文件路径。
fn parse_target() -> Option<PathBuf> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(&arg);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn main() {
    let target = parse_target();

    // --dump：只打印整页 HTML，便于无显示环境下测试渲染
    if std::env::args().any(|a| a == "--dump" || a == "--print") {
        let (files, idx) = match &target {
            Some(p) => discover(p),
            None => (Vec::new(), 0),
        };
        print!("{}", full_page(&files, idx));
        return;
    }

    // 单实例：已有窗口在跑就把路径转发过去并退出，复用那个窗口切到新文件。
    let _instance = SingleInstance::new(&singleton_name()).ok();
    let is_primary = _instance.as_ref().map(|i| i.is_single()).unwrap_or(true);
    dbg_log(&format!("start target={target:?} is_primary={is_primary}"));
    if !is_primary {
        if let Some(t) = &target {
            if forward_to_primary(t) {
                return;
            }
        }
        // 转发失败（primary 已退出 / 端口文件失效）→ 退化为自己开一个窗口
    }

    let (mut files, mut idx) = match &target {
        Some(p) => discover(p),
        None => (Vec::new(), 0),
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    if is_primary {
        spawn_listener(event_loop.create_proxy());
    }
    let proxy = event_loop.create_proxy();

    let init_title = if files.is_empty() {
        "Markio Preview".to_string()
    } else {
        file_title(&files[idx])
    };

    // 先隐藏建窗：避免空白闪烁；有内容时再显示。
    // 唯一保持隐藏的情形是"经 Open With 启动、argv 无路径、且已有 primary"——
    // 这种进程只等 Event::Opened 拿到路径后转发给 primary 再退出，全程不显示。
    let window = WindowBuilder::new()
        .with_title(&init_title)
        .with_inner_size(LogicalSize::new(920.0, 840.0))
        .with_min_inner_size(LogicalSize::new(480.0, 360.0))
        .with_visible(false)
        .build(&event_loop)
        .expect("创建窗口失败");

    let webview = WebViewBuilder::new()
        .with_html(full_page(&files, idx))
        .with_ipc_handler(move |req| {
            let _ = proxy.send_event(UserEvent::Ipc(req.into_body()));
        })
        .build(&window)
        .expect("创建 webview 失败");

    if target.is_some() || is_primary {
        window.set_visible(true);
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Ipc(body)) => {
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                match v.get("action").and_then(|a| a.as_str()).unwrap_or("") {
                    "next" => {
                        if idx + 1 < files.len() {
                            idx += 1;
                        } else {
                            return;
                        }
                    }
                    "prev" => {
                        if idx > 0 {
                            idx -= 1;
                        } else {
                            return;
                        }
                    }
                    "open" => match v.get("idx").and_then(|x| x.as_u64()) {
                        Some(i) if (i as usize) < files.len() && i as usize != idx => {
                            idx = i as usize;
                        }
                        _ => return,
                    },
                    "close" => {
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                    _ => return,
                }
                push_doc(&webview, &window, &files, idx);
            }
            Event::UserEvent(UserEvent::Open(path)) => {
                let (nf, ni) = discover(&path);
                files = nf;
                idx = ni;
                push_doc(&webview, &window, &files, idx);
                window.set_visible(true);
                window.set_focus();
            }
            // macOS "用…打开" / 双击 / 启动文档：tao 经 application:openURLs: 暴露为 Opened。
            // 这是 argv 拿不到路径的路径，单实例转发只能在这里做。
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            Event::Opened { urls } => {
                dbg_log(&format!("Opened urls={urls:?}"));
                let path = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .find(|p| p.is_file());
                dbg_log(&format!(
                    "Opened resolved path={path:?} is_primary={is_primary}"
                ));
                if let Some(path) = path {
                    // 已有 primary 时把请求转发过去并退出；但转发失败（primary 正退出 /
                    // 端口文件失效）则不能静默丢弃——退化为本进程自己显示这篇。
                    if !is_primary && forward_to_primary(&path) {
                        *control_flow = ControlFlow::Exit;
                        return;
                    }
                    let (nf, ni) = discover(&path);
                    files = nf;
                    idx = ni;
                    push_doc(&webview, &window, &files, idx);
                    window.set_visible(true);
                    window.set_focus();
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

/// 渲染 `files[idx]` 并推给 webview（替换文件条 + 正文 + 标题）。
fn push_doc(webview: &wry::WebView, window: &tao::window::Window, files: &[PathBuf], idx: usize) {
    if files.is_empty() {
        return;
    }
    let payload = DocPayload {
        title: file_title(&files[idx]),
        bar: bar_html(files, idx),
        body: render_body(&files[idx]),
    };
    if let Ok(json) = serde_json::to_string(&payload) {
        let _ = webview.evaluate_script(&format!("window.__setDoc({json})"));
    }
    window.set_title(&payload.title);
}
