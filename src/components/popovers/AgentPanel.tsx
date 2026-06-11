import { useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";
import {
  isExternalAgentAllowedInCurrentRegion,
} from "@/lib/ai-region-policy";
import type {
  AgentEvent,
  AgentPermission,
  AgentProvider,
  AgentProviderInfo,
} from "@/types";

type Block =
  | { kind: "init"; provider: AgentProvider; binary: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id?: string; tool: string; input: unknown; output?: unknown; isError?: boolean }
  | { kind: "result"; text: string; tokens?: { input: number | null; output: number | null } }
  | { kind: "error"; message: string };

const NEUTRAL_PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: "本地 Agent A",
  codex: "本地 Agent B",
  gemini: "本地 Agent C",
};

function providerDisplayName(id: AgentProvider): string {
  return NEUTRAL_PROVIDER_LABEL[id];
}

function newSessionId() {
  return `ag${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function AgentPanel({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const setToast = useUI((s) => s.setToast);

  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [permission, setPermission] = useState<AgentPermission>("safe");
  const [prompt, setPrompt] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const agentAllowed = isExternalAgentAllowedInCurrentRegion();

  // 组件卸载时兜底解绑事件监听（如路由切换强制卸载，避免监听泄漏）
  useEffect(
    () => () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!agentAllowed) return;
    void api.agentListProviders().then((list) => {
      setProviders(list);
      // 自动选第一个可用的 provider
      const first = list.find((p) => p.available);
      if (first) setProvider(first.id);
    });
  }, [agentAllowed]);

  useEffect(() => {
    if (!agentAllowed) onClose();
  }, [agentAllowed, onClose]);

  useEffect(() => {
    if (blockRef.current) {
      blockRef.current.scrollTop = blockRef.current.scrollHeight;
    }
  }, [blocks]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider],
  );

  const appendBlock = (b: Block) => setBlocks((cur) => [...cur, b]);

  const updateLastText = (text: string) =>
    setBlocks((cur) => {
      const last = cur[cur.length - 1];
      if (last && last.kind === "text") {
        return [...cur.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...cur, { kind: "text", text }];
    });

  const updateLastThinking = (text: string) =>
    setBlocks((cur) => {
      const last = cur[cur.length - 1];
      if (last && last.kind === "thinking") {
        return [...cur.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...cur, { kind: "thinking", text }];
    });

  const closeToolWithOutput = (id: string, output: unknown, isError: boolean) =>
    setBlocks((cur) => {
      for (let i = cur.length - 1; i >= 0; i--) {
        const b = cur[i];
        if (!b || b.kind !== "tool" || b.output !== undefined) continue;
        // 优先按 tool_use id 关联；无 id（其它 provider）时退回"最近一个未闭合的工具块"
        if (id && b.id && b.id !== id) continue;
        const updated: Block = { ...b, output, isError };
        return [...cur.slice(0, i), updated, ...cur.slice(i + 1)];
      }
      return cur;
    });

  const run = async () => {
    if (!prompt.trim() || running) return;
    if (!agentAllowed) {
      onClose();
      return;
    }
    if (!activeProvider?.available) {
      setToast({
        stage: "error",
        message: `${providerDisplayName(provider)} 未检测到二进制`,
      });
      return;
    }

    const sessionId = newSessionId();
    setBlocks([]);
    setRunning(sessionId);

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<AgentEvent>(`agent-event-${sessionId}`, (e) => {
        const evt = e.payload;
        switch (evt.type) {
          case "init":
            appendBlock({
              kind: "init",
              provider: evt.provider,
              binary: evt.binary,
            });
            break;
          case "text_delta":
            updateLastText(evt.text);
            break;
          case "thinking_delta":
            updateLastThinking(evt.text);
            break;
          case "tool_start":
            appendBlock({ kind: "tool", id: evt.id, tool: evt.tool, input: evt.input });
            break;
          case "tool_done":
            closeToolWithOutput(evt.id, evt.output, evt.is_error);
            break;
          case "result":
            appendBlock({
              kind: "result",
              text: evt.text,
              tokens: { input: evt.input_tokens, output: evt.output_tokens },
            });
            break;
          case "error":
            appendBlock({ kind: "error", message: evt.message });
            break;
          case "done":
            setRunning(null);
            if (unlisten) {
              unlisten();
              unlisten = null;
              unlistenRef.current = null;
            }
            break;
        }
      });
      unlistenRef.current = unlisten;

      await api.agentRun({
        sessionId,
        provider,
        prompt: prompt.trim(),
        workspace: ws?.path,
        permission,
      });
    } catch (err) {
      appendBlock({ kind: "error", message: (err as Error).message });
      setRunning(null);
      if (unlisten) {
        unlisten();
        unlistenRef.current = null;
      }
    }
  };

  const cancel = async () => {
    if (!running) return;
    try {
      await api.agentCancel(running);
    } catch (err) {
      setToast({ stage: "error", message: `取消失败：${(err as Error).message}` });
    }
  };

  if (!agentAllowed) return null;

  return (
    <div className="workspace-overlay" onClick={(e) => e.stopPropagation()}>
      <div
        className="ai-workspace"
        style={{ display: "flex", flexDirection: "column", height: "100%" }}
      >
        <div className="ai-top">
          <div className="ai-top-l">
            <div className="ai-glow" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                Local Agent · {providerDisplayName(provider)}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
                spawn 本地 CLI，在当前 vault 工作目录内运行。{" "}
                {ws ? `vault: ${ws.name}` : "(没有打开的仓库)"}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="settings-btn"
            onClick={onClose}
            disabled={!!running}
            style={{ padding: "4px 10px" }}
          >
            <Icon name="x" size={12} /> 关闭
          </button>
        </div>

        <div
          style={{
            padding: "8px 16px",
            borderBottom: "0.5px solid var(--border)",
            display: "flex",
            gap: 16,
            alignItems: "center",
            flexWrap: "wrap",
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", gap: 4 }}>
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className={"settings-btn" + (provider === p.id ? " active" : "")}
                onClick={() => setProvider(p.id)}
                disabled={!p.available || !!running}
                title={p.available ? p.binaryPath ?? "" : "未在 PATH 中检测到二进制"}
                style={{
                  padding: "3px 10px",
                  fontSize: 11,
                  opacity: p.available ? 1 : 0.4,
                }}
              >
                {providerDisplayName(p.id)}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 4 }}>
            {(["safe", "poweruser"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={"settings-btn" + (permission === m ? " active" : "")}
                onClick={() => setPermission(m)}
                disabled={!!running}
                style={{ padding: "3px 10px", fontSize: 11 }}
                title={
                  m === "safe"
                    ? "只允许 Read/Glob/Grep/WebFetch 工具"
                    : "允许写文件、执行命令（需要谨慎）"
                }
              >
                {m === "safe" ? "只读" : "可写"}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={blockRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 24px",
            background: "var(--bg-pane)",
          }}
        >
          {blocks.length === 0 && !running && (
            <div
              style={{
                color: "var(--text-3)",
                fontSize: 12,
                textAlign: "center",
                marginTop: 40,
                lineHeight: 1.8,
              }}
            >
              输入指令后按 ⌘↵ 发送。
              <br />
              Agent 会在你的 vault 目录里运行（cwd =vault）。
              <br />
              <br />
              示例：
              <br />
              <code>列出 vault 里所有标题包含"项目"的笔记</code>
              <br />
              <code>总结 ./inbox 下最近 7 天的所有笔记成一个 outline</code>
            </div>
          )}
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>

        <div
          style={{
            padding: 12,
            borderTop: "0.5px solid var(--border)",
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
          }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="跟 agent 说话…（⌘↵ 发送）"
            rows={3}
            style={{
              flex: 1,
              resize: "none",
              padding: 8,
              background: "var(--bg-pane-2)",
              border: "0.5px solid var(--border)",
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 12,
              color: "var(--text)",
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void run();
              }
            }}
            disabled={!!running}
          />
          {running ? (
            <button
              type="button"
              className="settings-btn"
              onClick={() => void cancel()}
              style={{ padding: "8px 14px", color: "#d44" }}
            >
              取消
            </button>
          ) : (
            <button
              type="button"
              className="settings-btn"
              onClick={() => void run()}
              disabled={!prompt.trim() || !activeProvider?.available || !agentAllowed}
              style={{ padding: "8px 14px" }}
            >
              发送 ⌘↵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "init":
      return (
        <div style={pill("var(--text-3)")}>
          <Icon name="bot" size={11} /> 已连接 {providerDisplayName(block.provider)} ·{" "}
          <code style={{ fontSize: 10 }}>{block.binary}</code>
        </div>
      );
    case "text":
      return (
        <div
          style={{
            whiteSpace: "pre-wrap",
            lineHeight: 1.6,
            fontSize: 13,
            margin: "8px 0",
            color: "var(--text)",
          }}
        >
          {block.text}
        </div>
      );
    case "thinking":
      return (
        <details
          style={{
            margin: "6px 0",
            padding: "6px 10px",
            background: "var(--bg-pane-2)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
            fontSize: 11,
            color: "var(--text-3)",
          }}
        >
          <summary style={{ cursor: "pointer" }}>thinking…</summary>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{block.text}</div>
        </details>
      );
    case "tool":
      return (
        <div
          style={{
            margin: "6px 0",
            padding: "6px 10px",
            background: "var(--bg-pane-2)",
            border: `0.5px solid ${block.isError ? "#d44" : "var(--border)"}`,
            borderRadius: 6,
            fontSize: 11,
            color: "var(--text-2)",
          }}
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Icon name="wand" size={11} />
            <code>{block.tool || "tool"}</code>
            {block.output === undefined ? (
              <span style={{ color: "var(--text-3)" }}>· running…</span>
            ) : (
              <span style={{ color: block.isError ? "#d44" : "var(--text-3)" }}>
                · {block.isError ? "error" : "done"}
              </span>
            )}
          </div>
          {block.input != null && (
            <pre
              style={{
                marginTop: 4,
                fontSize: 10,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {JSON.stringify(block.input, null, 2)}
            </pre>
          )}
          {block.output !== undefined && (
            <pre
              style={{
                marginTop: 4,
                fontSize: 10,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: block.isError ? "#d44" : "var(--text-2)",
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {typeof block.output === "string"
                ? block.output
                : JSON.stringify(block.output, null, 2)}
            </pre>
          )}
        </div>
      );
    case "result":
      return (
        <div
          style={{
            margin: "12px 0 4px",
            padding: "10px 12px",
            background: "var(--bg-pane-2)",
            border: "0.5px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-3)",
              marginBottom: 6,
              display: "flex",
              gap: 8,
            }}
          >
            <span>✓ 完成</span>
            {block.tokens?.input != null && (
              <span>
                in:{block.tokens.input} / out:{block.tokens.output ?? "?"} tokens
              </span>
            )}
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6 }}>
            {block.text}
          </div>
        </div>
      );
    case "error":
      return <div style={pill("#d44")}>错误：{block.message}</div>;
  }
}

function pill(color: string): React.CSSProperties {
  return {
    margin: "6px 0",
    padding: "6px 10px",
    background: "var(--bg-pane-2)",
    border: "0.5px solid var(--border)",
    borderRadius: 6,
    fontSize: 11,
    color,
    display: "inline-flex",
    gap: 6,
    alignItems: "center",
  };
}
