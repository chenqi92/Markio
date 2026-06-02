//! 本地 AI CLI agent 接入层。
//!
//! 设计参考 tolaria：把 claude / codex / gemini 这些命令行 agent 统一封装成
//! 同一组事件流（Init / TextDelta / ThinkingDelta / ToolStart / ToolDone /
//! Result / Error / Done），前端只需要处理一种事件流，不用关心是哪个 CLI。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

// ────────────────────────────── provider ──────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Claude,
    Codex,
    Gemini,
}

impl AgentProvider {
    fn binary(self) -> &'static str {
        match self {
            AgentProvider::Claude => "claude",
            AgentProvider::Codex => "codex",
            AgentProvider::Gemini => "gemini",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    /// 只读：只允许 Read / Glob / Grep / WebFetch 这类工具
    #[default]
    Safe,
    /// 允许写 / 执行命令（用户明确授权）
    PowerUser,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: AgentProvider,
    pub label: &'static str,
    pub available: bool,
    /// 检测到的二进制路径（PATH 里找到的）
    pub binary_path: Option<String>,
}

/// 检测本机有哪些 agent CLI 可用。
pub fn detect_providers() -> Vec<ProviderInfo> {
    [
        (AgentProvider::Claude, "Claude Code"),
        (AgentProvider::Codex, "Codex CLI"),
        (AgentProvider::Gemini, "Gemini CLI"),
    ]
    .into_iter()
    .map(|(id, label)| {
        let binary_path = which_binary(id.binary());
        ProviderInfo {
            id,
            label,
            available: binary_path.is_some(),
            binary_path,
        }
    })
    .collect()
}

/// 在 PATH 里找二进制。比起拉 `which` crate，自己拼一下 $PATH 更省依赖。
fn which_binary(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path) {
        let candidate = entry.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
        #[cfg(windows)]
        {
            for ext in &["exe", "cmd", "bat"] {
                let with_ext = entry.join(format!("{name}.{ext}"));
                if with_ext.is_file() {
                    return Some(with_ext.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

// ────────────────────────────── event 协议 ──────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// session 创建（包含可选的 session_id 用于 CLI 续聊）
    Init {
        session_id: Option<String>,
        provider: AgentProvider,
        binary: String,
    },
    /// 普通文本增量（直接渲染）
    TextDelta { text: String },
    /// thinking / reasoning 增量（前端可折叠）
    ThinkingDelta { text: String },
    /// 工具开始执行
    ToolStart {
        /// Claude 的 tool_use id；前端据此把 ToolDone 关联回对应的 ToolStart
        #[serde(default)]
        id: String,
        tool: String,
        input: serde_json::Value,
    },
    /// 工具执行完成（success or error）
    ToolDone {
        /// 对应 ToolStart 的 id（来自 Claude 的 tool_use_id）
        #[serde(default)]
        id: String,
        tool: String,
        output: serde_json::Value,
        is_error: bool,
    },
    /// agent 给出最终结论
    Result {
        text: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    /// 出错
    Error { message: String },
    /// 流结束（无论成功失败都会发一次）
    Done,
}

// ────────────────────────────── 取消 / 会话 ──────────────────────────────

struct SessionHandle {
    cancel: Arc<AtomicBool>,
    child_id: Option<u32>,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionHandle>> {
    static CELL: OnceLock<Mutex<HashMap<String, SessionHandle>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_session(id: &str, cancel: Arc<AtomicBool>) {
    if let Ok(mut map) = sessions().lock() {
        map.insert(
            id.to_string(),
            SessionHandle {
                cancel,
                child_id: None,
            },
        );
    }
}

fn record_child(id: &str, child_id: Option<u32>) {
    if let Ok(mut map) = sessions().lock() {
        if let Some(h) = map.get_mut(id) {
            h.child_id = child_id;
        }
    }
}

fn drop_session(id: &str) {
    if let Ok(mut map) = sessions().lock() {
        map.remove(id);
    }
}

pub fn cancel_session(id: &str) {
    let mut child_id_to_kill: Option<u32> = None;
    if let Ok(map) = sessions().lock() {
        if let Some(h) = map.get(id) {
            h.cancel.store(true, Ordering::SeqCst);
            child_id_to_kill = h.child_id;
        }
    }
    // tokio::Child 没法跨 await 直接取出 kill；记录 child_id 后调系统 signal。
    if let Some(pid) = child_id_to_kill {
        let _ = kill_pid(pid);
    }
}

#[cfg(unix)]
fn kill_pid(pid: u32) -> std::io::Result<()> {
    use std::process::Command as StdCommand;
    StdCommand::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status()?;
    Ok(())
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> std::io::Result<()> {
    use std::process::Command as StdCommand;
    StdCommand::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/F")
        .status()?;
    Ok(())
}

// ────────────────────────────── 启动入口 ──────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub session_id: String,
    pub provider: AgentProvider,
    pub prompt: String,
    /// vault 根目录，作为 agent 的工作目录
    pub workspace: Option<String>,
    pub permission: Option<PermissionMode>,
}

fn emit(app: &AppHandle, session_id: &str, evt: AgentEvent) {
    let _ = app.emit(&format!("agent-event-{session_id}"), evt);
}

pub async fn run(app: AppHandle, req: AgentRunRequest) {
    let cancel = Arc::new(AtomicBool::new(false));
    register_session(&req.session_id, cancel.clone());

    let result = match req.provider {
        AgentProvider::Claude => run_claude(&app, &req, cancel.clone()).await,
        AgentProvider::Codex => run_generic(&app, &req, cancel.clone()).await,
        AgentProvider::Gemini => run_generic(&app, &req, cancel.clone()).await,
    };

    if let Err(msg) = result {
        if !cancel.load(Ordering::SeqCst) {
            emit(&app, &req.session_id, AgentEvent::Error { message: msg });
        }
    }
    emit(&app, &req.session_id, AgentEvent::Done);
    drop_session(&req.session_id);
}

// ────────────────────────────── Claude Code 适配 ──────────────────────────────

#[derive(Debug, Deserialize)]
struct ClaudeLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    message: Option<ClaudeMessage>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    #[serde(default)]
    content: Vec<ClaudeContent>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClaudeContent {
    Text {
        #[serde(default)]
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    ToolUse {
        #[serde(default)]
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    ToolResult {
        #[serde(default)]
        tool_use_id: String,
        #[serde(default)]
        content: serde_json::Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
}

async fn run_claude(
    app: &AppHandle,
    req: &AgentRunRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let binary = which_binary("claude")
        .ok_or_else(|| "claude CLI 未找到，请确认已安装并在 PATH 里".to_string())?;
    let mut cmd = Command::new(&binary);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose"); // verbose 模式下 stream-json 会输出更细粒度的事件

    if let Some(ws) = req.workspace.as_deref() {
        cmd.arg("--add-dir").arg(ws);
        cmd.current_dir(ws);
    }

    let permission = req.permission.unwrap_or_default();
    match permission {
        PermissionMode::Safe => {
            // 只读：限制成 read-only 工具集
            cmd.arg("--allowed-tools")
                .arg("Read,Glob,Grep,WebFetch,WebSearch");
        }
        PermissionMode::PowerUser => {
            cmd.arg("--permission-mode").arg("acceptEdits");
        }
    }
    cmd.arg(&req.prompt);

    let mut child = spawn_child(cmd, &req.session_id).await?;
    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    emit(
        app,
        &req.session_id,
        AgentEvent::Init {
            session_id: None,
            provider: AgentProvider::Claude,
            binary,
        },
    );

    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|e| format!("读 stdout 失败：{e}"))?
    {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let parsed: serde_json::Result<ClaudeLine> = serde_json::from_str(&line);
        match parsed {
            Ok(l) => handle_claude_line(app, &req.session_id, l),
            Err(_) => {
                // 非 JSON 行：当成原始文本回传，方便调试
                emit(
                    app,
                    &req.session_id,
                    AgentEvent::TextDelta { text: line.clone() },
                );
            }
        }
    }

    let _ = child.wait().await;
    Ok(())
}

fn handle_claude_line(app: &AppHandle, sid: &str, line: ClaudeLine) {
    match line.kind.as_str() {
        "system" if line.subtype.as_deref() == Some("init") => {
            // 升级 Init 事件，带上 session_id
            emit(
                app,
                sid,
                AgentEvent::Init {
                    session_id: line.session_id.clone(),
                    provider: AgentProvider::Claude,
                    binary: "claude".to_string(),
                },
            );
        }
        "assistant" => {
            if let Some(msg) = line.message {
                for c in msg.content {
                    match c {
                        ClaudeContent::Text { text } if !text.is_empty() => {
                            emit(app, sid, AgentEvent::TextDelta { text });
                        }
                        ClaudeContent::Thinking { thinking } if !thinking.is_empty() => {
                            emit(app, sid, AgentEvent::ThinkingDelta { text: thinking });
                        }
                        ClaudeContent::ToolUse { id, name, input } => {
                            emit(app, sid, AgentEvent::ToolStart { id, tool: name, input });
                        }
                        _ => {}
                    }
                }
            }
        }
        "user" => {
            // user 消息里嵌的是 tool_result
            if let Some(msg) = line.message {
                for c in msg.content {
                    if let ClaudeContent::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = c
                    {
                        emit(
                            app,
                            sid,
                            AgentEvent::ToolDone {
                                id: tool_use_id,
                                tool: String::new(),
                                output: content,
                                is_error,
                            },
                        );
                    }
                }
            }
        }
        "result" => {
            let usage = line.usage;
            emit(
                app,
                sid,
                AgentEvent::Result {
                    text: line.result.unwrap_or_default(),
                    input_tokens: usage.as_ref().and_then(|u| u.input_tokens),
                    output_tokens: usage.as_ref().and_then(|u| u.output_tokens),
                },
            );
        }
        _ => {}
    }
}

// ────────────────────────────── 通用 fallback ──────────────────────────────

/// codex / gemini 暂时走通用路径：spawn → 逐行 stdout 当成 TextDelta。
/// 后续可以为每家加专属 JSON parser，框架已经在了。
async fn run_generic(
    app: &AppHandle,
    req: &AgentRunRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let bin_name = req.provider.binary();
    let binary = which_binary(bin_name)
        .ok_or_else(|| format!("{bin_name} CLI 未找到，请确认已安装并在 PATH 里"))?;

    let mut cmd = Command::new(&binary);
    if let Some(ws) = req.workspace.as_deref() {
        cmd.current_dir(ws);
    }

    // codex: codex exec "<prompt>"
    // gemini: gemini --prompt "<prompt>"
    match req.provider {
        AgentProvider::Codex => {
            cmd.arg("exec").arg(&req.prompt);
        }
        AgentProvider::Gemini => {
            cmd.arg("--prompt").arg(&req.prompt);
        }
        AgentProvider::Claude => unreachable!("claude 走 run_claude"),
    }

    let mut child = spawn_child(cmd, &req.session_id).await?;
    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    emit(
        app,
        &req.session_id,
        AgentEvent::Init {
            session_id: None,
            provider: req.provider,
            binary,
        },
    );

    let mut full_text = String::new();
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|e| format!("读 stdout 失败：{e}"))?
    {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        full_text.push_str(&line);
        full_text.push('\n');
        emit(
            app,
            &req.session_id,
            AgentEvent::TextDelta {
                text: format!("{line}\n"),
            },
        );
    }
    let _ = child.wait().await;
    emit(
        app,
        &req.session_id,
        AgentEvent::Result {
            text: full_text,
            input_tokens: None,
            output_tokens: None,
        },
    );
    Ok(())
}

async fn spawn_child(mut cmd: Command, session_id: &str) -> Result<Child, String> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("spawn 失败：{e}"))?;
    record_child(session_id, child.id());
    Ok(child)
}
