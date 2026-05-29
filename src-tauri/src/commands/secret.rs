//! 系统钥匙串 secret 管理。
//!
//! 出于安全：
//! - 不允许前端读取明文（secret_get 总返回错误）
//! - 账户名必须在白名单里（is_allowed_secret_account）
//! - secret_copy 允许在白名单两个账户间复制，明文不出 Rust 进程

use crate::secrets;

pub(crate) fn is_allowed_secret_account(account: &str) -> bool {
    matches!(
        account,
        "ai:anthropic"
            | "ai:openai"
            | "ai:deepseek"
            | "ai:ollama"
            | "ai:google"
            | "ai:custom"
            | "ai:nvidia"
            | "ai:xai"
            | "ai:groq"
            | "ai:openrouter"
            | "ai:siliconflow"
            | "ai:zhipu"
            | "ai:dashscope"
            | "ai:moonshot"
            | "ai:mistral"
            | "ai:together"
            | "embed:openai"
            | "rerank:cohere"
    )
}

fn validate_secret_account(account: &str) -> Result<(), String> {
    if is_allowed_secret_account(account) {
        Ok(())
    } else {
        Err("拒绝访问该密钥账户".to_string())
    }
}

#[tauri::command]
pub fn secret_set(account: String, value: String) -> Result<(), String> {
    validate_secret_account(&account)?;
    secrets::set(&account, &value)
}

#[tauri::command]
pub fn secret_get(_account: String) -> Result<Option<String>, String> {
    Err("出于安全考虑，不允许从前端读取密钥明文".to_string())
}

/// 在 keychain 内复制条目：把 from 账户的明文取出，写到 to 账户。
/// 明文不离开 Rust 进程。两个账户都必须在 is_allowed_secret_account 白名单里。
/// 用途：RAG embedding 想复用 AI 助手某个 provider 的 key 时调用。
#[tauri::command]
pub fn secret_copy(from: String, to: String) -> Result<bool, String> {
    validate_secret_account(&from)?;
    validate_secret_account(&to)?;
    if from == to {
        return Ok(true);
    }
    match secrets::get(&from) {
        Ok(Some(value)) => {
            secrets::set(&to, &value).map_err(|e| format!("写入失败：{e}"))?;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(format!("读取来源密钥失败：{e}")),
    }
}

#[tauri::command]
pub fn secret_has(account: String) -> Result<bool, String> {
    validate_secret_account(&account)?;
    Ok(secrets::has(&account))
}

#[tauri::command]
pub fn secret_delete(account: String) -> Result<(), String> {
    validate_secret_account(&account)?;
    secrets::delete(&account)
}
