import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";

interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  time: string;
}

const SUGGESTIONS = [
  "把这段改写得更简洁",
  "总结当前笔记的核心要点",
  "找出文中可能的错别字与病句",
  "继续往下写一段",
];

export function AIPanel({ onClose }: { onClose: () => void }) {
  const provider = useSettings((s) => s.aiProvider);
  const keyConfigured = useSettings((s) => s.aiKeyConfigured);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWorkspace = useSettings((s) => s.aiUseWorkspace);
  const tab = useTabs((s) => s.activeTab());
  const openSettings = useUI((s) => s.openSettings);

  const configured = provider === "ollama" || keyConfigured;

  const greeting = configured
    ? `已连接 ${provider} · ${model}。我可以帮你阅读 / 改写 / 总结当前笔记。`
    : "尚未配置 API。先到 设置 → AI 助手 里填上 Key 就能开始真正对话。";

  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: "intro",
      role: "assistant",
      text: greeting,
      time: nowStr(),
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [msgs.length, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const userMsg: Msg = {
      id: String(Date.now()),
      role: "user",
      text,
      time: nowStr(),
    };
    const nextMsgs = [...msgs, userMsg];
    setMsgs(nextMsgs);
    setInput("");
    setBusy(true);

    if (!configured) {
      setMsgs((m) => [
        ...m,
        {
          id: String(Date.now() + 1),
          role: "assistant",
          text: "请先到 设置 → AI 助手 填好 API Key 再试。",
          time: nowStr(),
        },
      ]);
      setBusy(false);
      return;
    }

    // ─── 组装 system prompt ─────────────────────────────────────────
    const parts: string[] = [];
    parts.push(
      "你是 markio 内嵌的写作助手。回答简洁、直接；遇到 markdown 用 markdown 回复。",
    );
    if (tab && useCurrentFile) {
      const head = tab.content.slice(0, 6000);
      parts.push(
        `当前打开的笔记：${tab.title}\n相对路径：${tab.path}\n\n--- 笔记内容（前 6000 字符）---\n${head}`,
      );
    }
    if (useWorkspace) {
      try {
        const { useWorkspace: wsStore } = await import("@/stores/workspace");
        const ws = wsStore.getState().activeWorkspace();
        if (ws) {
          const hits = await api.aiRetrieve(ws.path, text, 5);
          if (hits.length > 0) {
            const ctx = hits
              .map(
                (h, i) =>
                  `### 片段 ${i + 1} · ${h.name}${h.line ? `:${h.line}` : ""}\n\n${h.snippet}`,
              )
              .join("\n\n---\n\n");
            parts.push(
              `以下是仓库里跟用户提问相关的片段（关键词检索，可能并不精准）：\n\n${ctx}`,
            );
          }
        }
      } catch {
        /* 检索失败不致命，继续问 */
      }
    }
    const system = parts.length > 1 ? parts.join("\n\n") : undefined;

    try {
      const r = await api.aiChat({
        provider,
        endpoint: endpoint || undefined,
        model,
        maxTokens,
        temperature,
        system,
        messages: nextMsgs.map((m) => ({ role: m.role, content: m.text })),
      });
      setMsgs((m) => [
        ...m,
        {
          id: String(Date.now() + 2),
          role: "assistant",
          text: r.text || "（空响应）",
          time: nowStr(),
        },
      ]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        {
          id: String(Date.now() + 3),
          role: "assistant",
          text: `请求失败：${(e as Error).message}`,
          time: nowStr(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-panel">
      <div className="ai-header">
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background:
              "linear-gradient(135deg, var(--accent), var(--accent-2))",
            color: "white",
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 10px var(--accent-glow)",
          }}
        >
          <Icon name="sparkle" size={15} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>AI 助手</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {configured
              ? `${provider} · ${model}`
              : "未配置 · 设置 → AI 助手 接入"}
          </div>
        </div>
        {!configured && (
          <button
            type="button"
            className="settings-btn"
            onClick={() => openSettings(true)}
          >
            去配置
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          title="关闭 ⌘J"
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="ai-chat scroll" ref={scrollRef}>
        {msgs.map((m) => (
          <div key={m.id} className={"ai-msg " + m.role}>
            <div className="ai-avatar">
              {m.role === "user" ? "你" : <Icon name="sparkle" size={13} />}
            </div>
            <div className="ai-bubble">
              <div className="ai-text">{m.text}</div>
              <div className="ai-time">{m.time}</div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="ai-msg assistant">
            <div className="ai-avatar">
              <Icon name="sparkle" size={13} />
            </div>
            <div className="ai-bubble">
              <span className="ai-dot" />
              <span className="ai-dot" />
              <span className="ai-dot" />
            </div>
          </div>
        )}
      </div>
      <div className="ai-input-wrap">
        <div className="ai-suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              type="button"
              key={s}
              className="ai-chip"
              onClick={() => send(s)}
              disabled={busy}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="ai-input">
          <textarea
            placeholder="问 AI 任何关于这篇笔记的问题…（⌘↩ 发送）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
          />
          <button
            type="button"
            className="ai-send"
            onClick={() => send(input)}
            disabled={!input.trim() || busy}
          >
            <Icon name="sparkle" size={13} />
            <span>发送</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function nowStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
