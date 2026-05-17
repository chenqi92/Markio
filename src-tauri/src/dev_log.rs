//! 开发期日志（dev-only）。
//!
//! 把前端 console.* / window.error / unhandledrejection、ErrorBoundary 抓到的
//! componentStack，以及 Rust 侧 panic / 显式埋点（`devlog!`），统一写到项目根
//! `dev-logs/dev-YYYY-MM-DD.log`（JSONL）。
//!
//! 文件位置 = `env!("CARGO_MANIFEST_DIR")` 的父目录 + `dev-logs/`，仅在
//! `debug_assertions` 下生效；release 构建里 `dev_log_append` 命令直接返回 Ok，
//! `devlog!` 宏展开为空。
//!
//! 该模块对线程安全做了兜底（OnceLock<Mutex>），但仅追加写、不持久持有句柄。

#[cfg(debug_assertions)]
use std::path::PathBuf;
#[cfg(debug_assertions)]
use std::sync::Mutex;
#[cfg(debug_assertions)]
use std::sync::OnceLock;

#[cfg(debug_assertions)]
use serde_json::{json, Value};

#[cfg(debug_assertions)]
static DEV_LOG_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(debug_assertions)]
fn dev_log_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = <root>/src-tauri；上一级即项目根。
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("dev-logs"))
        .unwrap_or_else(|| PathBuf::from("dev-logs"))
}

#[cfg(debug_assertions)]
fn dev_log_path() -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    dev_log_dir().join(format!("dev-{date}.log"))
}

#[cfg(debug_assertions)]
fn write_line(line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let lock = DEV_LOG_MUTEX.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let dir = dev_log_dir();
    std::fs::create_dir_all(&dir)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dev_log_path())?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

#[cfg(debug_assertions)]
fn now_iso() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 前端走 invoke 把一条日志投递过来；release 下空实现。
#[cfg(debug_assertions)]
#[tauri::command]
pub fn dev_log_append(
    level: String,
    src: String,
    msg: String,
    fields: Option<Value>,
) -> Result<(), String> {
    let mut obj = json!({
        "ts": now_iso(),
        "level": level,
        "src": src,
        "msg": msg,
    });
    if let Some(Value::Object(extra)) = fields {
        if let Value::Object(ref mut base) = obj {
            for (k, v) in extra {
                base.insert(k, v);
            }
        }
    }
    let line = serde_json::to_string(&obj).map_err(|e| e.to_string())?;
    write_line(&line).map_err(|e| e.to_string())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn dev_log_append(
    _level: String,
    _src: String,
    _msg: String,
    _fields: Option<serde_json::Value>,
) -> Result<(), String> {
    Ok(())
}

/// Rust 侧埋点：仅 debug 写文件。
#[cfg(debug_assertions)]
#[allow(dead_code)]
pub fn devlog(level: &str, src: &str, msg: &str) {
    let line = serde_json::to_string(&json!({
        "ts": now_iso(),
        "level": level,
        "src": src,
        "msg": msg,
    }))
    .unwrap_or_else(|_| String::from("{}"));
    let _ = write_line(&line);
}

#[cfg(not(debug_assertions))]
#[allow(dead_code)]
pub fn devlog(_level: &str, _src: &str, _msg: &str) {}

/// 安装 panic hook，把 Rust panic 也吐到 dev-logs/。
/// 不替换默认 hook 的行为（仍打印到 stderr）。
#[cfg(debug_assertions)]
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| {
                info.payload()
                    .downcast_ref::<String>()
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| String::from("(non-string panic payload)"));
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let line = serde_json::to_string(&json!({
            "ts": now_iso(),
            "level": "fatal",
            "src": "rust",
            "msg": payload,
            "loc": loc,
        }))
        .unwrap_or_else(|_| String::from("{}"));
        let _ = write_line(&line);
        prev(info);
    }));
}

#[cfg(not(debug_assertions))]
pub fn install_panic_hook() {}
