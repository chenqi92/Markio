//! 内置 OAuth 应用凭据（编译期注入，不进源码 / git）。
//!
//! 对我们持有官方开发者凭据的网盘，用户无需自己去开发者后台申请 client_id，
//! 打开自己的账号一键登录即可。凭据由 build.rs 在编译期以 `cargo:rustc-env`
//! 注入，源码里只用 `option_env!` 读占位：二进制里有值就启用「一键登录」，
//! 没值就回退到「用户自填 client_id」（现有行为）。
//!
//! 注入来源（见 build.rs）：CI secret 环境变量，或本地 gitignore 的
//! `src-tauri/credentials.env` 文件。真实 key 绝不提交。
//!
//! Google / 微软 OneDrive / Dropbox 走 PKCE 公共客户端，不需要 client_secret；
//! 百度 / 阿里强制要 secret，按用户选择直接内置进客户端（可被逆向提取，已知权衡）。

fn non_empty(v: Option<&'static str>) -> Option<&'static str> {
    match v {
        Some(s) if !s.trim().is_empty() => Some(s.trim()),
        _ => None,
    }
}

/// 某 provider 的内置 client_id（app key）。没有内置则返回 None。
pub fn client_id(provider: &str) -> Option<&'static str> {
    let v = match provider {
        "gdrive" => option_env!("MARKIO_GDRIVE_CLIENT_ID"),
        "onedrive" => option_env!("MARKIO_ONEDRIVE_CLIENT_ID"),
        "dropbox" => option_env!("MARKIO_DROPBOX_CLIENT_ID"),
        "baidu" => option_env!("MARKIO_BAIDU_CLIENT_ID"),
        "aliyun" => option_env!("MARKIO_ALIYUN_APP_ID"),
        _ => None,
    };
    non_empty(v)
}

/// 某 provider 的内置 client_secret（仅百度 / 阿里需要；PKCE 类无）。
#[allow(dead_code)] // 百度 / 阿里 provider 接入后使用
pub fn client_secret(provider: &str) -> Option<&'static str> {
    let v = match provider {
        "dropbox" => option_env!("MARKIO_DROPBOX_SECRET"),
        "baidu" => option_env!("MARKIO_BAIDU_SECRET"),
        "aliyun" => option_env!("MARKIO_ALIYUN_SECRET"),
        _ => None,
    };
    non_empty(v)
}

/// 解析「运行时传入的 client_id」与「内置 client_id」：
/// 传入非空 → 用传入（高级用户自带 key）；传入空 → 回退内置；都没有 → Err。
pub fn resolve_client_id(provider: &str, passed: &str) -> Result<String, String> {
    let passed = passed.trim();
    if !passed.is_empty() {
        return Ok(passed.to_string());
    }
    client_id(provider)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{provider} 未内置 client_id，请在设置里填写自己的 client_id"))
}

/// 列出已内置 client_id 的 provider，前端据此显示「一键登录」而非「填 client_id」。
#[tauri::command]
pub fn builtin_oauth_providers() -> Vec<String> {
    ["gdrive", "onedrive", "dropbox", "baidu", "aliyun"]
        .into_iter()
        .filter(|p| client_id(p).is_some())
        .map(|p| p.to_string())
        .collect()
}
