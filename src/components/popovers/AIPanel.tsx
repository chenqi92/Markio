import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useAISessions, type AIMsgRecord, type AIMsgRef } from "@/stores/aiSessions";
import { useRag } from "@/stores/rag";
import { api } from "@/lib/api";
import { AISidebar } from "./AISidebar";
import { AIAssistantMessage } from "./AIAssistantMessage";
import { AIPreview } from "./AIPreview";

function nowTimeStr(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type AIMode =
  | "ask"
  | "summarize"
  | "draft"
  | "write"
  | "rewrite"
  | "translate"
  | "explain"
  | "brainstorm"
  | "code"
  | "proof";

const MODES: Array<{ id: AIMode; label: string; sub: string; icon: IconName }> = [
  { id: "ask", label: "提问", sub: "结合仓库回答", icon: "message" },
  { id: "summarize", label: "总结", sub: "把多份笔记压缩成要点", icon: "list" },
  { id: "draft", label: "续写", sub: "基于已有内容继续", icon: "edit" },
  { id: "write", label: "写作", sub: "从零起草长文", icon: "wand" },
  { id: "rewrite", label: "重写", sub: "换语气 / 风格 / 长度", icon: "sync" },
  { id: "translate", label: "翻译", sub: "中英互译，保留 markdown", icon: "type" },
  { id: "explain", label: "解释", sub: "把选中片段拆解给我听", icon: "info" },
  { id: "brainstorm", label: "头脑风暴", sub: "对一个主题发散 N 个想法", icon: "lightbulb" },
  { id: "code", label: "代码", sub: "生成 / 解释 / 重构代码", icon: "code" },
  { id: "proof", label: "校对", sub: "找错别字、病句、不通顺", icon: "check-square" },
];

const MODE_SYSTEM: Record<AIMode, string> = {
  ask: "你是一个写作助手，结合提供的笔记上下文回答问题，回答简洁、直接，遇到 markdown 用 markdown 回复。",
  summarize: "你是一个总结助手。读取提供的笔记内容，输出 5–8 条要点 + 一句话核心结论，用 markdown 列表。",
  draft: "你是一个续写助手。沿用提供的笔记的语气与结构，自然衔接续写一段（不超过 400 字）。",
  write: "你是一个长文起草助手。按用户的主题，输出包含 H2 / H3 小节的完整 markdown 草稿。",
  rewrite: "你是一个改写助手。保留原意，按用户指定的语气 / 风格 / 长度重写。先输出改写结果，再用「修改说明」列出 3–5 条调整点。",
  translate: "你是一个翻译助手。中英互译，保留 markdown 语法。输出原文 + 译文双栏；遇到术语保留原文并用括号标注译法。",
  explain: "你是一个讲解助手。把提供的片段拆成 1) 这是什么 2) 它怎么工作 3) 为什么这么设计 三段，避免空话。",
  brainstorm: "你是一个发散助手。围绕主题列 5–8 条可执行方向，每条 1 句标题 + 1 句子说明，标注「易/中/难」。",
  code: "你是一个写代码助手。代码块包裹在 markdown fenced 里并标语言；解释部分简短，避免空话。",
  proof: "你是一个校对助手。先列出问题（错别字 / 病句 / 标点 / 中英文空格），再给出建议改稿，最后总结改动数量。",
};

/** 输入框上方的快速操作 —— 点击只填充 draft，让用户在发送前确认 / 改写 */
const AI_QUICK: Array<{ id: string; ico: string; label: string }> = [
  { id: "summarize", ico: "≣", label: "总结当前文档" },
  { id: "translate", ico: "文", label: "翻译选中段" },
  { id: "continue", ico: "✎", label: "续写下一段" },
  { id: "code", ico: "</>", label: "写一段代码" },
  { id: "brainstorm", ico: "✺", label: "围绕主题发散" },
  { id: "weekly", ico: "📅", label: "本周笔记生成周报" },
];

const SUGGESTIONS_FOR: Record<AIMode, string[]> = {
  ask: [
    "我这周写过哪些和这个项目相关的笔记？",
    "总结仓库里最近一篇关于设计原则的笔记",
    "笔记里出现频率最高的标签是哪些？",
  ],
  summarize: [
    "把当前打开的笔记压缩成 6 条要点",
    "总结仓库里所有带 #book 的笔记",
  ],
  draft: ["基于当前笔记的开头续写 200 字"],
  write: [
    "围绕\"反脆弱\"写一篇 600 字的随笔",
    "写一份本周工作的复盘提纲",
  ],
  rewrite: [
    "把当前段落改得更口语化",
    "把当前笔记的开头压缩到 1 句话",
  ],
  translate: [
    "把当前选区翻成英文",
    "把这段中文翻成日文，保留 markdown 格式",
  ],
  explain: ["把这段代码逐行解释给我"],
  brainstorm: ["围绕\"知识库\"给我发散 5 个写作方向"],
  code: ["用 React 给我写一个 markdown live preview 组件"],
  proof: ["校对一下：我们应该让用户随时可以回到任何一个时间点,从而 鼓励他们大胆改写"],
};

/** 各 provider 下的常见模型 —— 用户也可以在设置里手填覆盖 */
const MODELS_BY_PROVIDER: Record<string, Array<{ id: string; name: string; tag: string }>> = {
  anthropic: [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tag: "默认 · 最快" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", tag: "推理 · 长文档" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", tag: "复杂任务" },
  ],
  openai: [
    { id: "gpt-4o-mini", name: "GPT-4o mini", tag: "默认 · 便宜" },
    { id: "gpt-4o", name: "GPT-4o", tag: "通用" },
    { id: "o1-mini", name: "o1-mini", tag: "推理" },
  ],
  google: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tag: "默认 · 快" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tag: "推理 · 长文档" },
  ],
  deepseek: [
    { id: "deepseek-chat", name: "DeepSeek V3", tag: "通用" },
    { id: "deepseek-reasoner", name: "DeepSeek R1", tag: "推理" },
  ],
  ollama: [
    { id: "qwen2.5:14b", name: "Qwen 2.5 14B", tag: "本地 · 推荐" },
    { id: "llama3.2:3b", name: "Llama 3.2 3B", tag: "本地 · 轻量" },
    { id: "mistral:7b", name: "Mistral 7B", tag: "本地 · 通用" },
  ],
  custom: [],
};

export function AIPanel({ onClose }: { onClose: () => void }) {
  const provider = useSettings((s) => s.aiProvider);
  const keyConfigured = useSettings((s) => s.aiKeyConfigured);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const setAi = useSettings((s) => s.setAi);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWorkspaceCtx = useSettings((s) => s.aiUseWorkspace);
  const tab = useTabs((s) => s.activeTab());
  const openSettings = useUI((s) => s.openSettings);

  const [aiMode, setAIMode] = useState<AIMode>("ask");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ws = useWorkspace((s) => s.activeWorkspace());
  const sessions = useAISessions((s) => s.sessions);
  const activeSessionId = useAISessions((s) => s.activeId);
  const createSession = useAISessions((s) => s.createSession);
  const appendMessage = useAISessions((s) => s.appendMessage);
  const appendChunk = useAISessions((s) => s.appendChunk);
  const patchMessage = useAISessions((s) => s.patchMessage);
  const scope = useAISessions((s) => s.scope);
  const streamCancelRef = useRef<(() => Promise<void>) | null>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const history: AIMsgRecord[] = activeSession?.messages ?? [];

  const configured = provider === "ollama" || keyConfigured;

  const subtitle = useMemo(() => {
    if (!configured) return "未配置 · 设置 → AI 助手 接入";
    const m = MODES.find((x) => x.id === aiMode);
    return `${m?.sub ?? ""} · ${provider} · ${model}`;
  }, [configured, aiMode, provider, model]);

  const modelList = MODELS_BY_PROVIDER[provider] ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [history.length, busy]);

  useEffect(() => {
    return () => {
      void streamCancelRef.current?.();
    };
  }, []);

  // 切 provider 时如果当前 model 不在列表里，回到第一个
  useEffect(() => {
    if (modelList.length === 0) return;
    if (!modelList.find((m) => m.id === model)) {
      setAi({ aiModel: modelList[0].id });
    }
  }, [provider, modelList, model, setAi]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;

    // 确保有活动 session（首次发送时建一个）
    let sessionId = activeSessionId;
    if (!sessionId) {
      sessionId = createSession(ws?.id ?? null, aiMode);
    }

    const now = Date.now();
    const userMsg: AIMsgRecord = {
      id: `m${now}`,
      role: "user",
      text,
      time: now,
    };
    appendMessage(sessionId, userMsg);
    setDraft("");
    setBusy(true);

    if (!configured) {
      appendMessage(sessionId, {
        id: `m${now + 1}`,
        role: "assistant",
        text: "请先到 设置 → AI 助手 填好 API Key 再试。",
        time: Date.now(),
      });
      setBusy(false);
      return;
    }

    // 组装 system prompt（按 scope）
    const parts: string[] = [MODE_SYSTEM[aiMode]];
    // scope = open: 把所有打开的 tab 内容塞进去；当前 tab 提到最前
    if (scope === "open") {
      const allTabs = useTabs.getState().tabs;
      for (const t of allTabs.slice(0, 5)) {
        parts.push(
          `--- ${t.title} ---\n${t.content.slice(0, 4000)}`,
        );
      }
    } else if (tab && useCurrentFile) {
      // 默认与 all / folder / tag / custom 模式：单文件上下文（短期实现）
      parts.push(
        `当前打开的笔记：${tab.title}\n路径：${tab.path}\n\n--- 内容（前 6000 字符）---\n${tab.content.slice(0, 6000)}`,
      );
    }
    let collectedRefs: AIMsgRef[] = [];
    let retrievalNote: string | null = null;
    if ((useWorkspaceCtx || scope !== "open") && ws) {
      const ragEnabled = useSettings.getState().ragEnabled;
      const ragStatus = useRag.getState().status[ws.id];
      const hasIndex = (ragStatus?.totalChunks ?? 0) > 0;
      const indexing = ragStatus?.progress?.running ?? false;
      let used = false;
      if (ragEnabled && hasIndex) {
        try {
          const hits = await useRag.getState().search(ws.path, text);
          if (hits.length > 0) {
            collectedRefs = hits.map((h) => ({
              path: h.path,
              heading: h.heading,
              body: h.body,
              score: h.score,
              source: h.source,
            }));
            const ctx = hits
              .map((h, i) => {
                const file = h.path.split("/").slice(-1)[0] ?? h.path;
                const head = h.heading ? `\n小节：${h.heading}` : "";
                return `### 片段 ${i + 1} · ${file} (${h.source})${head}\n\n${h.body}`;
              })
              .join("\n\n---\n\n");
            parts.push(
              `仓库相关片段（混合检索：向量 + 关键词 + 引用图）：\n\n${ctx}`,
            );
            used = true;
          }
        } catch (e) {
          console.warn("[ai.send] rag.search failed, fallback to grep", e);
        }
      } else if (ragEnabled && !hasIndex) {
        retrievalNote = indexing
          ? "本地索引正在构建中，本次回答暂用关键词检索。"
          : "本地索引尚未构建。在右侧侧栏点「构建本地索引」开启向量检索。";
      } else if (!ragEnabled) {
        retrievalNote = "当前为关键词检索模式。在右侧侧栏可启用本地索引。";
      }
      if (!used) {
        try {
          const hits = await api.aiRetrieve(ws.path, text, 5);
          if (hits.length > 0) {
            collectedRefs = hits.map((h) => ({
              path: h.path,
              heading: h.line ? `第 ${h.line} 行` : "",
              body: h.snippet,
              score: 0,
              source: "grep",
            }));
            const ctx = hits
              .map(
                (h, i) =>
                  `### 片段 ${i + 1} · ${h.name}${h.line ? `:${h.line}` : ""}\n\n${h.snippet}`,
              )
              .join("\n\n---\n\n");
            const header = retrievalNote
              ? `${retrievalNote}\n\n仓库相关片段（关键词检索）：`
              : "仓库相关片段（关键词检索）：";
            parts.push(`${header}\n\n${ctx}`);
          } else if (retrievalNote) {
            parts.push(retrievalNote);
          }
        } catch {
          /* ignore */
        }
      }
    }
    const system = parts.join("\n\n");

    // 拿历史给 API（注意：appendMessage 已写入 store，但 history ref 还没更新）
    const updated = useAISessions
      .getState()
      .sessions.find((s) => s.id === sessionId);
    const msgs = updated?.messages ?? [];

    // 先占位一条空 assistant 消息，流式追加 delta
    const assistantId = `m${Date.now()}`;
    appendMessage(sessionId, {
      id: assistantId,
      role: "assistant",
      text: "",
      time: Date.now(),
      refs: collectedRefs.length > 0 ? collectedRefs : undefined,
    });

    let receivedAny = false;
    const finalize = () => {
      streamCancelRef.current = null;
      setBusy(false);
    };

    try {
      const { cancel } = await api.aiChatStream(
        {
          provider,
          endpoint: endpoint || undefined,
          model,
          maxTokens,
          temperature,
          system,
          messages: msgs.map((m) => ({ role: m.role, content: m.text })),
        },
        {
          onChunk: (delta) => {
            receivedAny = true;
            appendChunk(sessionId, assistantId, delta);
          },
          onDone: () => {
            if (!receivedAny) {
              patchMessage(sessionId, assistantId, { text: "（空响应）" });
            }
            finalize();
          },
          onError: (message) => {
            patchMessage(sessionId, assistantId, {
              text: `请求失败：${message}`,
            });
            finalize();
          },
        },
      );
      streamCancelRef.current = cancel;
    } catch (e) {
      patchMessage(sessionId, assistantId, {
        text: `请求失败：${(e as Error).message}`,
      });
      finalize();
    }
  };

  const cancelStream = async () => {
    const fn = streamCancelRef.current;
    if (!fn) return;
    await fn();
    streamCancelRef.current = null;
    setBusy(false);
  };

  return (
    <div className="ai-workspace">
      <div className="ai-top">
        <div className="ai-top-l">
          <div className="ai-glow" />
          <div>
            <div className="ai-title">AI 助手</div>
            <div className="ai-sub">{subtitle}</div>
          </div>
        </div>
        <div className="ai-top-r">
          <button
            type="button"
            className="ai-pill"
            onClick={() => setModelMenuOpen((v) => !v)}
          >
            <span className={"ai-pill-dot" + (configured ? "" : " off")} />
            <span>
              {modelList.find((m) => m.id === model)?.name ?? (model || "未选模型")}
            </span>
            <span style={{ opacity: 0.5 }}>▾</span>
          </button>
          {modelMenuOpen && (
            <div
              className="ai-model-menu"
              onClick={(e) => e.stopPropagation()}
            >
              {modelList.length === 0 ? (
                <div
                  style={{
                    padding: "8px 10px",
                    fontSize: 11.5,
                    color: "var(--text-3)",
                  }}
                >
                  当前提供方没有内置模型清单，请到设置里手填 Model ID
                </div>
              ) : (
                modelList.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={
                      "ai-model-item" + (m.id === model ? " active" : "")
                    }
                    onClick={() => {
                      setAi({ aiModel: m.id });
                      setModelMenuOpen(false);
                    }}
                  >
                    <div className="t">{m.name}</div>
                    <div className="s">{m.tag}</div>
                  </button>
                ))
              )}
              <div className="ai-model-foot">
                <button
                  type="button"
                  onClick={() => {
                    setModelMenuOpen(false);
                    openSettings(true);
                  }}
                >
                  在 设置 → AI 助手 中管理
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="ai-exit"
            onClick={onClose}
            title="退出 AI 模式 (⌘J / Esc)"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>

      <div className="ai-workspace-body">
        <AISidebar aiMode={aiMode} />
        <div className="ai-main">
          <div
            className={"ai-body scroll" + (previewName ? " with-preview" : "")}
            ref={scrollRef}
          >
            <div className="ai-stream">
              {history.length === 0 ? (
                <div className="ai-welcome">
                  <div className="ai-welcome-orb" />
                  <h2>
                    {aiMode === "ask"
                      ? "问问你的知识库"
                      : `${MODES.find((m) => m.id === aiMode)?.label} 模式`}
                  </h2>
                  <p>
                    {configured
                      ? MODES.find((m) => m.id === aiMode)?.sub
                      : "尚未配置 API。先到 设置 → AI 助手 里填上 Key 就能开始真正对话。"}
                  </p>
                  <div className="ai-suggestions-stack">
                    {(SUGGESTIONS_FOR[aiMode] ?? SUGGESTIONS_FOR.ask).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="ai-sug"
                        onClick={() => send(s)}
                        disabled={busy}
                      >
                        <span className="ai-sug-ico">
                          <Icon name="sparkle" size={12} />
                        </span>
                        <span>{s}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                history.map((m, idx) => {
                  if (m.role === "user") {
                    return (
                      <div key={m.id} className="ai-msg user">
                        <div className="ai-msg-avatar user">你</div>
                        <div className="ai-msg-body">
                          <div className="ai-msg-text">{m.text}</div>
                          <div className="ai-msg-time">{nowTimeStr(m.time)}</div>
                        </div>
                      </div>
                    );
                  }
                  // 找到前一条 user 消息作为"重生成"的源
                  let prevUser: string | undefined;
                  for (let i = idx - 1; i >= 0; i--) {
                    if (history[i].role === "user") {
                      prevUser = history[i].text;
                      break;
                    }
                  }
                  return (
                    <AIAssistantMessage
                      key={m.id}
                      text={m.text}
                      time={m.time}
                      refs={m.refs}
                      prevUserText={prevUser}
                      onRegenerate={(t) => send(t)}
                      onWikiClick={(n) => setPreviewName(n)}
                    />
                  );
                })
              )}
              {busy && (
                <div className="ai-msg assistant">
                  <div className="ai-msg-avatar assistant">
                    <Icon name="sparkle" size={13} />
                  </div>
                  <div className="ai-msg-body">
                    <span className="ai-dot" />
                    <span className="ai-dot" />
                    <span className="ai-dot" />
                  </div>
                </div>
              )}
            </div>
            {previewName && (
              <AIPreview
                name={previewName}
                onClose={() => setPreviewName(null)}
              />
            )}
          </div>

          <AIInputBar
            aiMode={aiMode}
            setAIMode={setAIMode}
            currentTab={
              tab
                ? { title: tab.title, path: tab.path, content: tab.content }
                : null
            }
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            onSend={send}
            scope={scope}
            wsName={ws?.name ?? null}
            indexedCount={
              (() => {
                const rs = ws ? useRag.getState().status[ws.id] : null;
                if (rs && rs.totalChunks > 0) return rs.totalDocs;
                return useTabs.getState().tabs.length;
              })()
            }
            configured={configured}
          />
        </div>
      </div>
    </div>
  );
}

interface InputBarProps {
  aiMode: AIMode;
  currentTab: { title: string; path: string; content: string } | null;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  onSend: (text: string) => void;
  scope: string;
  wsName: string | null;
  indexedCount: number;
  configured: boolean;
}

function estimateTokens(text: string): number {
  // 中文按 1.5 tokens/字、英文按 1.3 tokens/word 估
  let cjk = 0;
  let words = 0;
  let inWord = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf);
    if (isCjk) {
      cjk++;
      inWord = false;
    } else if (/\w/.test(ch)) {
      if (!inWord) words++;
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return Math.round(cjk * 1.5 + words * 1.3);
}

interface InputBarPropsExt extends InputBarProps {
  setAIMode?: (mode: AIMode) => void;
}

function AIInputBar({
  aiMode,
  currentTab,
  draft,
  setDraft,
  busy,
  onSend,
  scope,
  wsName,
  indexedCount,
  configured,
  setAIMode,
}: InputBarPropsExt) {
  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWsCtx = useSettings((s) => s.aiUseWorkspace);
  const setAi = useSettings((s) => s.setAi);
  const setToast = useUI((s) => s.setToast);
  const model = useSettings((s) => s.aiModel);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const styleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!styleMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (styleRef.current && !styleRef.current.contains(e.target as Node)) {
        setStyleMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [styleMenuOpen]);

  const currentMode = MODES.find((m) => m.id === aiMode) ?? MODES[0];

  // 上下文 chip 列表：当前 tab（如果开启）+ scope=open 时其它 tab
  const ctxChips = useMemo(() => {
    const list: Array<{ id: string; label: string; pinned?: boolean }> = [];
    if (useCurrentFile && currentTab) {
      list.push({
        id: currentTab.path,
        label: currentTab.title.replace(/\.md$/i, ""),
        pinned: true,
      });
    }
    if (scope === "open") {
      const allTabs = useTabs.getState().tabs;
      for (const t of allTabs) {
        if (t.path === currentTab?.path) continue;
        list.push({ id: t.path, label: t.title.replace(/\.md$/i, "") });
      }
    }
    return list;
  }, [useCurrentFile, currentTab, scope]);

  const tokens = useMemo(() => {
    let total = estimateTokens(draft);
    if (useCurrentFile && currentTab) {
      total += estimateTokens(currentTab.content.slice(0, 6000));
    }
    if (scope === "open") {
      for (const t of useTabs.getState().tabs) {
        if (t.path === currentTab?.path) continue;
        total += estimateTokens(t.content.slice(0, 4000));
      }
    }
    return total;
  }, [draft, useCurrentFile, currentTab, scope]);

  const placeholder =
    aiMode === "ask"
      ? "问点什么，⌘↩ 发送，⇧↩ 换行…"
      : `描述你想 "${MODES.find((m) => m.id === aiMode)?.label}" 的内容…`;

  return (
    <>
      <div className="ai-input-wrap">
        <div className="ai-quick-row">
          {AI_QUICK.map((q) => (
            <button
              key={q.id}
              type="button"
              className="ai-quick"
              onClick={() => setDraft(q.label)}
              disabled={busy}
            >
              <span className="ico" aria-hidden>
                {q.ico}
              </span>
              <span>{q.label}</span>
            </button>
          ))}
        </div>
        <div className="ai-input-shell">
          <div className="ai-ctx-row">
            <span className="ai-ctx-l">上下文</span>
            {ctxChips.length === 0 ? (
              <span style={{ fontSize: 11, color: "var(--text-4)" }}>
                {useWsCtx ? "仓库 grep 检索 + 用户问题" : "仅用户问题"}
              </span>
            ) : (
              ctxChips.map((c) => (
                <span
                  key={c.id}
                  className={"ai-ctx-chip" + (c.pinned ? " pinned" : "")}
                  title={c.id}
                >
                  <span className="ico">
                    <Icon name={c.pinned ? "pin" : "note"} size={11} />
                  </span>
                  <span className="lbl">{c.label}</span>
                  {c.pinned && (
                    <button
                      type="button"
                      className="x"
                      title="不再把当前笔记当上下文"
                      onClick={() => setAi({ aiUseCurrentFile: false })}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))
            )}
            <button
              type="button"
              className="ai-ctx-add"
              title="切换 scope = 当前打开，把所有打开的 tab 当上下文"
              onClick={() => {
                if (scope !== "open") {
                  useAISessions.getState().setScope("open");
                  setToast({
                    stage: "done",
                    message: "已切到「当前打开的笔记」",
                  });
                  setTimeout(() => setToast(null), 1500);
                } else {
                  setAi({ aiUseWorkspace: !useWsCtx });
                  setToast({
                    stage: "done",
                    message: useWsCtx
                      ? "已关闭仓库检索"
                      : "已开启仓库 grep 检索",
                  });
                  setTimeout(() => setToast(null), 1500);
                }
              }}
            >
              <span style={{ fontSize: 12 }}>＠</span>
              <span>添加</span>
            </button>
            <span className="ai-ctx-meta">
              {ctxChips.length} 篇 · 约 {tokens.toLocaleString()} tokens
            </span>
          </div>

          <div className="ai-input-textarea-wrap">
            <textarea
              placeholder={placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  // 单按 Enter 发送，Shift+Enter 换行（按设计稿）
                  e.preventDefault();
                  onSend(draft);
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onSend(draft);
                }
              }}
              rows={1}
            />
          </div>

          <div className="ai-input-foot">
            <div className="ai-input-tools">
              <button
                type="button"
                className="ai-tool chip"
                onClick={() => {
                  setAi({ aiUseWorkspace: !useWsCtx });
                }}
                title={
                  useWsCtx
                    ? "已开启仓库 grep 检索，点击关闭"
                    : "开启时把仓库 grep 命中片段一起发给 AI"
                }
              >
                <Icon name="database" size={11} />
                <span>{useWsCtx ? "仓库检索 ✓" : "仓库检索 ⨯"}</span>
              </button>
              <button
                ref={styleRef}
                type="button"
                className="ai-tool chip ai-style-btn"
                title="回答风格 / 任务模式"
                onClick={() => setStyleMenuOpen((v) => !v)}
                style={{ position: "relative" }}
              >
                <Icon name="sparkle" size={11} />
                <span>✦ {currentMode.label}</span>
                <span style={{ opacity: 0.5, marginLeft: 2 }}>▾</span>
                {styleMenuOpen && (
                  <div
                    className="ai-style-menu"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="ai-style-h">回答风格</div>
                    {MODES.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        className={
                          "ai-style-item" + (m.id === aiMode ? " active" : "")
                        }
                        onClick={() => {
                          setAIMode?.(m.id);
                          setStyleMenuOpen(false);
                        }}
                      >
                        <div className="t">{m.label}</div>
                        <div className="s">{m.sub}</div>
                      </button>
                    ))}
                    <div className="ai-style-foot">
                      在 设置 → AI 助手 中编辑
                    </div>
                  </div>
                )}
              </button>
              <span className="ai-tool chip ai-tool-static" title="当前模型">
                <Icon name="sparkle" size={11} />
                <span>{model || "未选模型"}</span>
              </span>
            </div>
            <div className="ai-input-actions">
              <span
                className={
                  "ai-char-count" + (draft.length > 4000 ? " over" : "")
                }
              >
                {draft.length.toLocaleString()} / 4,000
              </span>
              <button
                type="button"
                className="ai-send"
                onClick={() => onSend(draft)}
                disabled={!draft.trim() || busy}
                title="发送（⌘↩ 或 ↩）"
              >
                <span>↑</span>
                <span>发送</span>
              </button>
            </div>
          </div>
        </div>

        <div className="ai-input-meta">
          <span className="meta-chip">
            <span
              className="dot"
              style={configured ? undefined : { background: "var(--text-4)", boxShadow: "none" }}
            />
            {configured ? `已连接 · ${wsName ?? "未选仓库"}` : "未配置 API"}
          </span>
          <span style={{ flex: 1 }} />
          <span className="meta-chip">
            索引模式 ·{" "}
            {scope === "all"
              ? "整个仓库"
              : scope === "folder"
              ? "当前文件夹"
              : scope === "open"
              ? "当前打开"
              : scope === "tag"
              ? "按标签"
              : "手动选择"}{" "}
            · {indexedCount} 篇
          </span>
          <span className="meta-chip" style={{ color: "var(--text-4)" }}>
            ⌘↩ 发送 · ⇧↩ 换行
          </span>
        </div>
      </div>
    </>
  );
}
