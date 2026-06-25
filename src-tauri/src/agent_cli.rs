//! 本地 AI CLI agent 接入层。
//!
//! 把 claude / codex / gemini / cursor-agent / opencode / qwen / copilot /
//! aider / goose 这些命令行 agent 统一封装成同一组事件流（Init / TextDelta /
//! ThinkingDelta / ToolStart / ToolDone / Result / Error / Done），前端只需要
//! 处理一种事件流，不用关心是哪个 CLI。
//!
//! 注意：本模块会 spawn 用户 PATH 里的外部可执行文件，macOS App Sandbox（Mac
//! App Store 上架版）禁止此行为，因此前端用 `__MARKIO_MAS__` 把整个功能裁掉，
//! 只在直发渠道（DMG / Windows / Linux）暴露。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

// ────────────────────────────── provider ──────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Claude,
    Codex,
    Gemini,
    Cursor,
    Opencode,
    Qwen,
    Copilot,
    Aider,
    Goose,
}

impl AgentProvider {
    fn binary(self) -> &'static str {
        match self {
            AgentProvider::Claude => "claude",
            AgentProvider::Codex => "codex",
            AgentProvider::Gemini => "gemini",
            AgentProvider::Cursor => "cursor-agent",
            AgentProvider::Opencode => "opencode",
            AgentProvider::Qwen => "qwen",
            AgentProvider::Copilot => "copilot",
            AgentProvider::Aider => "aider",
            AgentProvider::Goose => "goose",
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
        (AgentProvider::Cursor, "Cursor Agent"),
        (AgentProvider::Opencode, "OpenCode"),
        (AgentProvider::Qwen, "Qwen Code"),
        (AgentProvider::Copilot, "Copilot CLI"),
        (AgentProvider::Aider, "Aider"),
        (AgentProvider::Goose, "Goose"),
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

/// 构造一个 tokio Command。Windows 下 `.cmd` / `.bat`（npm 全局包常见的 shim）
/// 不是 PE，CreateProcess 没法直接拉起，必须经 `cmd /c` 转一层；其余情况直接执行。
fn make_command(program: &str) -> Command {
    #[cfg(windows)]
    {
        let lower = program.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(program);
            return c;
        }
    }
    Command::new(program)
}

/// 各家 CLI 的非交互调用参数（含 prompt 的摆放位置）。
///
/// `power=true` 对应前端的"可写"模式：尽量带上各家的自动批准开关，让 agent 能直接
/// 改文件 / 执行命令；`power=false`（只读）则不带这些开关，多数 CLI 在 stdin 关闭、
/// 无自动批准时只会读取 / 给建议，不落盘。各 CLI 参数随版本可能变化，新增后建议在
/// 目标机器上 smoke-test 一次。
fn generic_args(provider: AgentProvider, prompt: &str, power: bool) -> Vec<String> {
    let p = prompt.to_string();
    match provider {
        // codex exec "<prompt>"；可写模式放开沙箱与审批。
        AgentProvider::Codex => {
            let mut a = vec!["exec".to_string()];
            if power {
                a.push("--full-auto".to_string());
            }
            a.push(p);
            a
        }
        // gemini --prompt "<prompt>" [--yolo]
        AgentProvider::Gemini => {
            let mut a = vec!["--prompt".to_string(), p];
            if power {
                a.push("--yolo".to_string());
            }
            a
        }
        // qwen 是 gemini-cli 的分支，参数同构。
        AgentProvider::Qwen => {
            let mut a = vec!["--prompt".to_string(), p];
            if power {
                a.push("--yolo".to_string());
            }
            a
        }
        // opencode run "<prompt>"（headless 用 run 子命令，不是 -p）
        AgentProvider::Opencode => vec!["run".to_string(), p],
        // copilot -p "<prompt>" [--allow-all-tools]
        AgentProvider::Copilot => {
            let mut a = vec!["-p".to_string(), p];
            if power {
                a.push("--allow-all-tools".to_string());
            }
            a
        }
        // aider 总是要改文件，只在可写模式自动确认；只读模式 stdin 关闭基本只读不落盘。
        AgentProvider::Aider => {
            let mut a = vec!["--no-stream".to_string(), "--message".to_string(), p];
            if power {
                a.push("--yes-always".to_string());
            }
            a
        }
        // goose run -t "<prompt>"
        AgentProvider::Goose => vec!["run".to_string(), "-t".to_string(), p],
        // claude / cursor 有各自专属 runner（run_claude / run_cursor），不会落到这里。
        AgentProvider::Claude | AgentProvider::Cursor => vec![p],
    }
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
    // /T 连带杀子树：.cmd shim 经 `cmd /C` 转一层时，真正的 agent 是 cmd 的子进程。
    StdCommand::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
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

    // Claude Code 有稳定的 stream-json 协议，能解析出 thinking / 工具调用等细粒度
    // 事件；其余 CLI 走通用纯文本路径（按各家非交互参数调用，逐行回传 stdout）。
    let result = match req.provider {
        AgentProvider::Claude => run_claude(&app, &req, cancel.clone()).await,
        AgentProvider::Cursor => run_cursor(&app, &req, cancel.clone()).await,
        _ => run_generic(&app, &req, cancel.clone()).await,
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
    let mut cmd = make_command(&binary);
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
                            emit(
                                app,
                                sid,
                                AgentEvent::ToolStart {
                                    id,
                                    tool: name,
                                    input,
                                },
                            );
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

// ────────────────────────────── Cursor Agent 适配 ──────────────────────────────
//
// cursor-agent 的 stream-json 与 Claude 同源但有差异：工具事件是
// `{"type":"tool_call","subtype":"started|completed","call_id":..,"tool_call":{"<x>ToolCall":{args,result}}}`，
// 工具名藏在 tool_call 对象里那个唯一的 key（readToolCall / editToolCall / shellToolCall…）。
// 默认（不带 --stream-partial-output）每个 assistant 事件给的是整段文本而非累积增量，
// 因此按 turn 追加是安全的。

#[derive(Debug, Deserialize)]
struct CursorLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    message: Option<CursorMessage>,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    is_error: Option<bool>,
    #[serde(default)]
    call_id: Option<String>,
    #[serde(default)]
    tool_call: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CursorMessage {
    #[serde(default)]
    content: Vec<CursorContent>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CursorContent {
    Text {
        #[serde(default)]
        text: String,
    },
    #[serde(other)]
    Other,
}

/// 从 `tool_call` 对象里抽出 (工具名, 入参, 结果)。结构是单键对象，
/// 键名形如 `readToolCall`，去掉 `ToolCall` 后缀作为工具名。
fn parse_cursor_tool(
    tool_call: Option<&serde_json::Value>,
) -> (String, serde_json::Value, serde_json::Value) {
    let null = serde_json::Value::Null;
    if let Some(obj) = tool_call.and_then(|v| v.as_object()) {
        if let Some((key, val)) = obj.iter().next() {
            let name = key
                .strip_suffix("ToolCall")
                .unwrap_or(key.as_str())
                .to_string();
            let args = val.get("args").cloned().unwrap_or_else(|| null.clone());
            let result = val.get("result").cloned().unwrap_or(null);
            return (name, args, result);
        }
    }
    (String::new(), null.clone(), null)
}

fn handle_cursor_line(app: &AppHandle, sid: &str, line: CursorLine) {
    match line.kind.as_str() {
        "system" if line.subtype.as_deref() == Some("init") => {
            emit(
                app,
                sid,
                AgentEvent::Init {
                    session_id: line.session_id.clone(),
                    provider: AgentProvider::Cursor,
                    binary: "cursor-agent".to_string(),
                },
            );
        }
        "assistant" => {
            if let Some(msg) = line.message {
                for c in msg.content {
                    if let CursorContent::Text { text } = c {
                        if !text.is_empty() {
                            emit(app, sid, AgentEvent::TextDelta { text });
                        }
                    }
                }
            }
        }
        "tool_call" => {
            let (tool, args, result) = parse_cursor_tool(line.tool_call.as_ref());
            match line.subtype.as_deref() {
                Some("started") => emit(
                    app,
                    sid,
                    AgentEvent::ToolStart {
                        id: line.call_id.unwrap_or_default(),
                        tool,
                        input: args,
                    },
                ),
                Some("completed") => emit(
                    app,
                    sid,
                    AgentEvent::ToolDone {
                        id: line.call_id.unwrap_or_default(),
                        tool,
                        output: result,
                        is_error: line.is_error.unwrap_or(false),
                    },
                ),
                _ => {}
            }
        }
        "result" => {
            emit(
                app,
                sid,
                AgentEvent::Result {
                    text: line.result.unwrap_or_default(),
                    input_tokens: None,
                    output_tokens: None,
                },
            );
        }
        _ => {}
    }
}

async fn run_cursor(
    app: &AppHandle,
    req: &AgentRunRequest,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let binary = which_binary("cursor-agent")
        .ok_or_else(|| "cursor-agent CLI 未找到，请确认已安装并在 PATH 里".to_string())?;
    let mut cmd = make_command(&binary);
    cmd.arg("-p").arg("--output-format").arg("stream-json");

    if let Some(ws) = req.workspace.as_deref() {
        cmd.current_dir(ws);
    }
    // 可写模式：--force 自动批准编辑 / 执行命令。
    if matches!(
        req.permission.unwrap_or_default(),
        PermissionMode::PowerUser
    ) {
        cmd.arg("--force");
    }
    cmd.arg(&req.prompt);

    let mut child = spawn_child(cmd, &req.session_id).await?;
    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    // 抽干 stderr：未登录 / 报错都在这里，不读会显示空会话（理由同 run_generic）。
    let stderr = child.stderr.take();
    let err_buf: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let err_task = stderr.map(|se| {
        let buf = err_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(se).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut b) = buf.lock() {
                    b.push_str(&line);
                    b.push('\n');
                }
            }
        })
    });

    emit(
        app,
        &req.session_id,
        AgentEvent::Init {
            session_id: None,
            provider: AgentProvider::Cursor,
            binary,
        },
    );

    let mut saw_output = false;
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
        match serde_json::from_str::<CursorLine>(&line) {
            Ok(l) => {
                saw_output = true;
                handle_cursor_line(app, &req.session_id, l);
            }
            // 非 JSON 行：当原始文本回传，方便调试。
            Err(_) => {
                saw_output = true;
                emit(
                    app,
                    &req.session_id,
                    AgentEvent::TextDelta { text: line.clone() },
                );
            }
        }
    }

    let status = child.wait().await;
    if let Some(t) = err_task {
        let _ = t.await;
    }
    let stderr_text = err_buf.lock().map(|b| b.clone()).unwrap_or_default();
    let failed = matches!(status, Ok(s) if !s.success());
    if (!saw_output || failed) && !stderr_text.trim().is_empty() {
        emit(
            app,
            &req.session_id,
            AgentEvent::TextDelta {
                text: format!("\n[stderr] {}\n", stderr_text.trim()),
            },
        );
    }
    Ok(())
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

    let mut cmd = make_command(&binary);
    if let Some(ws) = req.workspace.as_deref() {
        cmd.current_dir(ws);
    }

    let power = matches!(
        req.permission.unwrap_or_default(),
        PermissionMode::PowerUser
    );
    for arg in generic_args(req.provider, &req.prompt, power) {
        cmd.arg(arg);
    }

    let mut child = spawn_child(cmd, &req.session_id).await?;
    let stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    // 并发抽干 stderr：① CLI 写超过管道缓冲(~64KB)而无人读会阻塞子进程，
    // 让 stdout 永不 EOF 把会话挂死；② 失败诊断(未登录/报错)都在 stderr，
    // 不读用户只能看到空会话。
    let stderr = child.stderr.take();
    let err_buf: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let err_task = stderr.map(|se| {
        let buf = err_buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(se).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut b) = buf.lock() {
                    b.push_str(&line);
                    b.push('\n');
                }
            }
        })
    });

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
    let status = child.wait().await;
    if let Some(t) = err_task {
        let _ = t.await;
    }
    let stderr_text = err_buf.lock().map(|b| b.clone()).unwrap_or_default();
    // stdout 没有有效输出但 stderr 有内容（或进程失败）时，把 stderr 透出来，
    // 避免会话显示为空让用户不知所措。
    let failed = matches!(status, Ok(s) if !s.success());
    if (full_text.trim().is_empty() || failed) && !stderr_text.trim().is_empty() {
        emit(
            app,
            &req.session_id,
            AgentEvent::TextDelta {
                text: format!("\n[stderr] {}\n", stderr_text.trim()),
            },
        );
        if full_text.trim().is_empty() {
            full_text = stderr_text;
        }
    }
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
