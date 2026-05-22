import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useSettings } from "@/stores/settings";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";
import { useAISessions, type AIMsgRecord, type AIMsgRef } from "@/stores/aiSessions";
import { useRag } from "@/stores/rag";
import { useVaultIndex } from "@/stores/vaultIndex";
import { reportDiagnostic } from "@/stores/diagnostics";
import { api } from "@/lib/api";
import * as aiCache from "@/lib/aiCache";
import { shortcutText } from "@/lib/shortcuts";
import { getProviderModels } from "@/lib/ai-providers";
import { runAgent, type AgentMsg } from "@/lib/ai-agent";
import { AISidebar } from "./AISidebar";
import { AIAssistantMessage } from "./AIAssistantMessage";
import { AIPreview } from "./AIPreview";
import { AIContextDrawer } from "./AIContextDrawer";

export interface AIAttachedItem {
  path: string;
  isDir: boolean;
}

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

// 模型列表统一从 src/lib/ai-providers.ts 取（Settings、AIPanel、Rust 默认 endpoint
// 同源），下方 modelList 调 getProviderModels(provider) 即可。

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

  const [aiMode, setAIMode] = useState<AIMode>("ask");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Agent 模式：让模型自己 list_dir / read_file / grep，多轮 tool-use 取回上下文。
  // 默认关；Anthropic / Google 暂不支持（后端会回明确错误）。
  const [agentMode, setAgentMode] = useState(false);
  const agentCancelRef = useRef(false);
  const [attachedItems, setAttachedItems] = useState<AIAttachedItem[]>([]);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [ctxDrawerOpen, setCtxDrawerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ensureVaultIndex = useVaultIndex((s) => s.ensure);

  const ws = useWorkspace((s) => s.activeWorkspace());
  const sessions = useAISessions((s) => s.sessions);
  const activeSessionId = useAISessions((s) => s.activeId);
  const createSession = useAISessions((s) => s.createSession);
  const appendMessage = useAISessions((s) => s.appendMessage);
  const appendChunk = useAISessions((s) => s.appendChunk);
  const patchMessage = useAISessions((s) => s.patchMessage);
  const scope = useAISessions((s) => s.scope);
  const streamCancelRef = useRef<(() => Promise<void>) | null>(null);
  // 每次 send / cancel 都 bump 这个 token。onChunk/onDone/onError 回调里
  // 用闭包记下入口时的 token，不一致则视为 stale 丢弃——避免：
  //   1) cancel 后 backend 已停 emit，但 in-flight 的 chunk 还要写一行
  //   2) 极端情况下旧请求 finalize 把新请求的 busy 标志清掉
  const streamTokenRef = useRef(0);

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

  const modelList = getProviderModels(provider);

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

  useEffect(() => {
    if (ws?.path) void ensureVaultIndex(ws.path);
  }, [ws?.path, ensureVaultIndex]);

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

    if (attachedItems.length > 0) {
      const idxFiles =
        (ws ? useVaultIndex.getState().index[ws.path]?.files : undefined) ?? [];
      for (const item of attachedItems) {
        if (item.isDir) {
          const sep = item.path.includes("\\") ? "\\" : "/";
          const prefix = item.path.endsWith(sep) ? item.path : item.path + sep;
          const inDir = idxFiles
            .filter((f) => f.path.startsWith(prefix))
            .slice(0, 10);
          const chunks: string[] = [];
          for (const f of inDir) {
            try {
              const c = await api.readText(f.path);
              chunks.push(`--- ${f.name} (${f.path}) ---\n${c.slice(0, 2000)}`);
            } catch (e) {
              console.warn("[ai.send] readText failed", f.path, e);
            }
          }
          if (chunks.length > 0) {
            parts.push(
              `已附加文件夹「${item.path}」下的内容（${chunks.length} 篇，单篇前 2000 字符）：\n\n${chunks.join("\n\n")}`,
            );
          }
        } else {
          try {
            const c = await api.readText(item.path);
            const name = item.path.split(/[\\/]/).pop() ?? item.path;
            parts.push(
              `已附加文件：${name}\n路径：${item.path}\n\n--- 内容（前 6000 字符）---\n${c.slice(0, 6000)}`,
            );
          } catch (e) {
            console.warn("[ai.send] readText failed", item.path, e);
          }
        }
      }
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
          retrievalNote = "本地索引检索失败，本次回答暂用关键词检索。";
          reportDiagnostic({
            source: "rag",
            severity: "warning",
            message: "AI 向量检索失败，已退回关键词检索",
            detail: e,
            workspace: ws.path,
          });
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
        } catch (e) {
          reportDiagnostic({
            source: "ai",
            severity: "warning",
            message: "AI 关键词检索失败",
            detail: e,
            workspace: ws.path,
          });
          if (retrievalNote) {
            parts.push(`${retrievalNote}\n关键词检索也失败，未附加仓库片段。`);
          }
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

    const myToken = ++streamTokenRef.current;
    const isStale = () => streamTokenRef.current !== myToken;
    let receivedAny = false;
    const finalize = () => {
      if (isStale()) return;
      streamCancelRef.current = null;
      setBusy(false);
    };

    const chatMessages = msgs.map((m) => ({ role: m.role, content: m.text }));

    // ─── Agent 模式分支 ──────────────────────────────────────────────────
    // 让模型自己 list_dir / read_file / grep 取上下文。期间用占位 assistant 显示
    // "📂 grep '本周'" 之类的 tool 状态行；最终文本拿到时一次性 patch 进去。
    if (agentMode && ws) {
      if (provider === "anthropic" || provider === "google") {
        patchMessage(sessionId, assistantId, {
          text: `Agent 模式暂不支持 ${provider}，请切到 OpenAI 兼容 provider（DeepSeek / Groq / Moonshot / xAI 等）或关闭 Agent。`,
        });
        finalize();
        return;
      }
      agentCancelRef.current = false;
      const trace: string[] = [];
      try {
        const result = await runAgent({
          provider,
          endpoint: endpoint || undefined,
          model,
          maxTokens,
          temperature,
          system,
          workspacePath: ws.path,
          messages: chatMessages as AgentMsg[],
          onToolCall: (call) => {
            if (isStale()) return;
            const args = JSON.stringify(call.input).slice(0, 80);
            trace.push(`▸ ${call.name} ${args}`);
            patchMessage(sessionId, assistantId, {
              text: trace.join("\n") + "\n\n_思考中…_",
            });
          },
          onToolDone: (call, output) => {
            if (isStale()) return;
            const summary =
              output.length > 200
                ? `${output.slice(0, 200)}…（共 ${output.length} 字符）`
                : output;
            trace[trace.length - 1] +=
              `\n  ${summary.split("\n").join("\n  ")}`;
            patchMessage(sessionId, assistantId, {
              text: trace.join("\n") + "\n\n_思考中…_",
            });
          },
          onFinalText: (text) => {
            if (isStale()) return;
            const header =
              trace.length > 0
                ? `<details><summary>Agent 调用了 ${trace.length} 次工具</summary>\n\n\`\`\`\n${trace.join("\n")}\n\`\`\`\n\n</details>\n\n`
                : "";
            patchMessage(sessionId, assistantId, {
              text: header + text,
            });
          },
          isCancelled: () => agentCancelRef.current,
        });
        if (!isStale() && !result.text) {
          patchMessage(sessionId, assistantId, { text: "（空响应）" });
        }
      } catch (e) {
        if (!isStale()) {
          patchMessage(sessionId, assistantId, {
            text: `Agent 请求失败：${(e as Error).message}`,
          });
        }
      }
      finalize();
      return;
    }

    // AI 缓存：完全相同的 (provider, model, system, messages) 直接回放上次响应。
    // 默认关；用户在设置开启后才走，避免改变默认"重新生成"语义。
    const cacheEnabled = useSettings.getState().aiCacheEnabled;
    if (cacheEnabled) {
      try {
        const key = await aiCache.makeKey(provider, model, system, chatMessages);
        const hit = aiCache.lookup(key);
        if (hit && !isStale()) {
          // 直接补齐 assistant 占位，不发起 API 请求
          patchMessage(sessionId, assistantId, {
            text: hit.text,
            refs: (hit.refs as typeof collectedRefs | null) ?? undefined,
          });
          finalize();
          return;
        }
      } catch {
        // SHA-256 / crypto.subtle 失败时静默回落到正常 API 调用
      }
    }

    try {
      const { cancel } = await api.aiChatStream(
        {
          provider,
          endpoint: endpoint || undefined,
          model,
          maxTokens,
          temperature,
          system,
          messages: chatMessages,
        },
        {
          onChunk: (delta) => {
            if (isStale()) return;
            receivedAny = true;
            appendChunk(sessionId, assistantId, delta);
          },
          onDone: () => {
            if (isStale()) return;
            if (!receivedAny) {
              patchMessage(sessionId, assistantId, { text: "（空响应）" });
            } else if (cacheEnabled) {
              // 写入缓存——读 store 拿当前累积的完整 text
              void aiCache
                .makeKey(provider, model, system, chatMessages)
                .then((key) => {
                  const cur = useAISessions
                    .getState()
                    .sessions.find((s) => s.id === sessionId)
                    ?.messages.find((m) => m.id === assistantId);
                  if (cur?.text) {
                    aiCache.remember(key, {
                      text: cur.text,
                      refs: collectedRefs.length > 0 ? collectedRefs : null,
                    });
                  }
                })
                .catch(() => undefined);
            }
            finalize();
          },
          onError: (message) => {
            if (isStale()) return;
            patchMessage(sessionId, assistantId, {
              text: `请求失败：${message}`,
            });
            finalize();
          },
        },
      );
      if (!isStale()) {
        streamCancelRef.current = cancel;
      } else {
        // 入口被 cancel 抢跑了，立刻关掉这个新启动的 stream
        void cancel();
      }
    } catch (e) {
      if (!isStale()) {
        patchMessage(sessionId, assistantId, {
          text: `请求失败：${(e as Error).message}`,
        });
        finalize();
      }
    }
  };

  const cancelStream = async () => {
    // bump 在 await 之前——in-flight 的 chunk 立刻被视为 stale，
    // 不会再写入 message（避免"取消后还在长字"的视觉 bug）
    streamTokenRef.current++;
    // Agent loop 跑在前端，不走 ai_chat_cancel；靠 cancel ref 让下一次 loop 检查时跳出
    agentCancelRef.current = true;
    const fn = streamCancelRef.current;
    streamCancelRef.current = null;
    setBusy(false);
    if (fn) await fn();
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
            className={"ai-top-btn" + (ctxDrawerOpen ? " on" : "")}
            onClick={() => setCtxDrawerOpen((v) => !v)}
            title="上下文管理"
          >
            <Icon name="sliders" size={12} />
            <span>上下文</span>
          </button>
          <button
            type="button"
            className="ai-top-close"
            onClick={onClose}
            title="返回编辑器 (esc)"
            aria-label="关闭"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>

      <div className="ai-workspace-body">
        <AISidebar aiMode={aiMode} />
        <div className="ai-main">
          {ctxDrawerOpen && (
            <AIContextDrawer
              attachedCount={attachedItems.length}
              onClose={() => setCtxDrawerOpen(false)}
            />
          )}
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
            attachedItems={attachedItems}
            setAttachedItems={setAttachedItems}
            modelList={modelList}
            agentMode={agentMode}
            setAgentMode={setAgentMode}
            provider={provider}
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
  attachedItems: AIAttachedItem[];
  setAttachedItems: (next: AIAttachedItem[] | ((prev: AIAttachedItem[]) => AIAttachedItem[])) => void;
  modelList: Array<{ id: string; name: string; tag: string }>;
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
  agentMode: boolean;
  setAgentMode: (next: boolean | ((v: boolean) => boolean)) => void;
  /** 当前 provider，用来禁用 anthropic / google 的 Agent 开关 */
  provider: string;
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
  attachedItems,
  setAttachedItems,
  modelList,
  agentMode,
  setAgentMode,
  provider,
}: InputBarPropsExt) {
  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWsCtx = useSettings((s) => s.aiUseWorkspace);
  const setAi = useSettings((s) => s.setAi);
  const setToast = useUI((s) => s.setToast);
  const openSettings = useUI((s) => s.openSettings);
  const model = useSettings((s) => s.aiModel);
  const ws = useWorkspace((s) => s.activeWorkspace());
  const vaultFiles = useVaultIndex((s) => (ws ? s.index[ws.path]?.files : undefined));
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const styleRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [atTrigger, setAtTrigger] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelWrapRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!pickerOpen) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      const insidePicker = pickerWrapRef.current?.contains(target);
      const insideTextarea = textareaRef.current?.contains(target);
      if (!insidePicker && !insideTextarea) {
        setPickerOpen(false);
        setAtTrigger(null);
      }
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [pickerOpen]);

  useEffect(() => {
    if (pickerOpen && !atTrigger) {
      setPickerQuery("");
      setTimeout(() => pickerInputRef.current?.focus(), 0);
    }
  }, [pickerOpen, atTrigger]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (
        modelWrapRef.current &&
        !modelWrapRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [modelMenuOpen]);

  const pickerCandidates = useMemo<{
    folders: string[];
    files: Array<{ path: string; name: string }>;
  }>(() => {
    if (!vaultFiles || !ws) return { folders: [], files: [] };
    const sep = ws.path.includes("\\") ? "\\" : "/";
    const folderSet = new Set<string>();
    for (const f of vaultFiles) {
      let dir = f.path;
      const cut = dir.lastIndexOf(sep);
      if (cut < 0) continue;
      dir = dir.substring(0, cut);
      while (dir.length > ws.path.length && dir.startsWith(ws.path + sep)) {
        folderSet.add(dir);
        const idx = dir.lastIndexOf(sep);
        if (idx <= ws.path.length) break;
        dir = dir.substring(0, idx);
      }
    }
    const folders = Array.from(folderSet);
    const q = pickerQuery.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    return {
      folders: folders
        .filter((p) => match(p))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 12),
      files: vaultFiles
        .filter((f) => match(f.path) || match(f.name))
        .slice(0, 30),
    };
  }, [vaultFiles, pickerQuery, ws]);

  const isAttached = (path: string) =>
    attachedItems.some((it) => it.path === path);

  const toggleAttach = (path: string, isDir: boolean) => {
    setAttachedItems((prev) => {
      if (prev.some((it) => it.path === path)) {
        return prev.filter((it) => it.path !== path);
      }
      return [...prev, { path, isDir }];
    });
  };

  const removeAttached = (path: string) => {
    setAttachedItems((prev) => prev.filter((it) => it.path !== path));
  };

  const attachByPath = (path: string, isDir: boolean) => {
    setAttachedItems((prev) =>
      prev.some((it) => it.path === path) ? prev : [...prev, { path, isDir }],
    );
  };

  const detectAtToken = (
    value: string,
    cursor: number,
  ): { start: number; end: number; query: string } | null => {
    let i = cursor - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i > 0 ? value[i - 1] : "";
        if (i === 0 || /\s/.test(prev)) {
          return {
            start: i,
            end: cursor,
            query: value.substring(i + 1, cursor),
          };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  };

  const updateAtFromTextarea = (value: string, cursor: number) => {
    const trig = detectAtToken(value, cursor);
    if (trig) {
      setAtTrigger({ start: trig.start, end: trig.end });
      setPickerQuery(trig.query);
      setPickerOpen(true);
    } else if (atTrigger) {
      setAtTrigger(null);
      setPickerOpen(false);
      setPickerQuery("");
    }
  };

  const handlePickerSelect = (path: string, isDir: boolean) => {
    if (atTrigger) {
      attachByPath(path, isDir);
      const next = draft.slice(0, atTrigger.start) + draft.slice(atTrigger.end);
      setDraft(next);
      setAtTrigger(null);
      setPickerOpen(false);
      setPickerQuery("");
      setTimeout(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          const pos = atTrigger.start;
          ta.setSelectionRange(pos, pos);
        }
      }, 0);
    } else {
      toggleAttach(path, isDir);
    }
  };

  const shortLabel = (p: string) => {
    const sep = p.includes("\\") ? "\\" : "/";
    const seg = p.split(sep).filter(Boolean);
    return seg[seg.length - 1] ?? p;
  };
  const relPath = (p: string) => {
    if (!ws) return p;
    const sep = ws.path.includes("\\") ? "\\" : "/";
    const prefix = ws.path.endsWith(sep) ? ws.path : ws.path + sep;
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  };

  const currentMode = MODES.find((m) => m.id === aiMode) ?? MODES[0];

  // 上下文 chip 列表：当前 tab（如果开启）+ scope=open 时其它 tab + @ 添加的文件/文件夹
  const ctxChips = useMemo(() => {
    const list: Array<{
      id: string;
      label: string;
      pinned?: boolean;
      attached?: boolean;
      isDir?: boolean;
    }> = [];
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
    for (const it of attachedItems) {
      list.push({
        id: it.path,
        label: shortLabel(it.path).replace(/\.md$/i, ""),
        attached: true,
        isDir: it.isDir,
      });
    }
    return list;
  }, [useCurrentFile, currentTab, scope, attachedItems]);

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
      ? shortcutText("问点什么，⌘↩ 发送，⇧↩ 换行…")
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
                  className={
                    "ai-ctx-chip" +
                    (c.pinned ? " pinned" : "") +
                    (c.attached ? " attached" : "")
                  }
                  title={c.id}
                >
                  <span className="ico">
                    <Icon
                      name={
                        c.pinned
                          ? "pin"
                          : c.isDir
                          ? "folder"
                          : "note"
                      }
                      size={11}
                    />
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
                  {c.attached && (
                    <button
                      type="button"
                      className="x"
                      title="移除附加上下文"
                      onClick={() => removeAttached(c.id)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))
            )}
            <div
              className="ai-ctx-add-wrap"
              ref={pickerWrapRef}
              style={{ position: "relative" }}
            >
              <button
                type="button"
                className="ai-ctx-add"
                title="从当前仓库选择文件或文件夹作为上下文"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={!ws}
              >
                <span style={{ fontSize: 12 }}>＠</span>
                <span>添加</span>
              </button>
              {pickerOpen && ws && (
                <div
                  className="ai-ctx-picker"
                  onClick={(e) => e.stopPropagation()}
                >
                  {atTrigger ? (
                    <div className="ai-ctx-picker-h ai-ctx-picker-at">
                      <span>@</span>
                      <span className="q">{pickerQuery || "输入名称…"}</span>
                      <span className="hint">↩ 选择 · Esc 取消</span>
                    </div>
                  ) : (
                    <div className="ai-ctx-picker-h">
                      <input
                        ref={pickerInputRef}
                        type="text"
                        value={pickerQuery}
                        onChange={(e) => setPickerQuery(e.target.value)}
                        placeholder="搜索文件 / 文件夹…"
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setPickerOpen(false);
                          }
                        }}
                      />
                    </div>
                  )}
                  <div className="ai-ctx-picker-body scroll">
                    {pickerCandidates.folders.length === 0 &&
                    pickerCandidates.files.length === 0 ? (
                      <div className="ai-ctx-picker-empty">
                        {vaultFiles
                          ? "没有匹配项"
                          : "仓库索引尚未构建，请稍候…"}
                      </div>
                    ) : (
                      <>
                        {pickerCandidates.folders.length > 0 && (
                          <div className="ai-ctx-picker-group">文件夹</div>
                        )}
                        {pickerCandidates.folders.map((p) => (
                          <button
                            type="button"
                            key={"d:" + p}
                            className={
                              "ai-ctx-picker-item" +
                              (isAttached(p) ? " on" : "")
                            }
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              handlePickerSelect(p, true);
                            }}
                          >
                            <Icon name="folder" size={12} />
                            <span className="t">{shortLabel(p)}</span>
                            <span className="s">{relPath(p)}</span>
                          </button>
                        ))}
                        {pickerCandidates.files.length > 0 && (
                          <div className="ai-ctx-picker-group">文件</div>
                        )}
                        {pickerCandidates.files.map((f) => (
                          <button
                            type="button"
                            key={"f:" + f.path}
                            className={
                              "ai-ctx-picker-item" +
                              (isAttached(f.path) ? " on" : "")
                            }
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              handlePickerSelect(f.path, false);
                            }}
                          >
                            <Icon name="note" size={12} />
                            <span className="t">{f.name.replace(/\.md$/i, "")}</span>
                            <span className="s">{relPath(f.path)}</span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="ai-ctx-picker-foot">
                    <span>{attachedItems.length} 个已附加</span>
                    <button
                      type="button"
                      onClick={() => setPickerOpen(false)}
                    >
                      完成
                    </button>
                  </div>
                </div>
              )}
            </div>
            <span className="ai-ctx-meta">
              {ctxChips.length} 篇 · 约 {tokens.toLocaleString()} tokens
            </span>
          </div>

          <div className="ai-input-textarea-wrap">
            <textarea
              ref={textareaRef}
              placeholder={placeholder}
              value={draft}
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                const cursor = e.target.selectionStart ?? v.length;
                updateAtFromTextarea(v, cursor);
              }}
              onKeyUp={(e) => {
                if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
                  const ta = e.target as HTMLTextAreaElement;
                  updateAtFromTextarea(ta.value, ta.selectionStart ?? 0);
                }
              }}
              onClick={(e) => {
                const ta = e.target as HTMLTextAreaElement;
                updateAtFromTextarea(ta.value, ta.selectionStart ?? 0);
              }}
              onKeyDown={(e) => {
                if (atTrigger && e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setAtTrigger(null);
                  setPickerOpen(false);
                  setPickerQuery("");
                  return;
                }
                if (atTrigger && e.key === "Enter") {
                  const first =
                    pickerCandidates.folders[0] ??
                    pickerCandidates.files[0]?.path;
                  if (first) {
                    e.preventDefault();
                    const isDir = pickerCandidates.folders.includes(first);
                    handlePickerSelect(first, isDir);
                    return;
                  }
                }
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
                className={"ai-tool chip" + (agentMode ? " active" : "")}
                onClick={() => {
                  if (provider === "anthropic" || provider === "google") return;
                  setAgentMode((v) => !v);
                }}
                disabled={provider === "anthropic" || provider === "google"}
                title={
                  provider === "anthropic" || provider === "google"
                    ? "Agent 模式暂未支持此 provider"
                    : agentMode
                      ? "Agent 模式：AI 自己 list_dir / read_file / grep 取上下文（关）"
                      : "Agent 模式：AI 自己 list_dir / read_file / grep 取上下文（开）"
                }
              >
                <Icon name="bot" size={11} />
                <span>Agent {agentMode ? "✓" : "⨯"}</span>
              </button>
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
              <div
                ref={modelWrapRef}
                style={{ position: "relative", display: "inline-flex" }}
              >
                <button
                  type="button"
                  className="ai-tool chip ai-model-btn"
                  title="切换模型"
                  onClick={() => setModelMenuOpen((v) => !v)}
                >
                  <Icon name="sparkle" size={11} />
                  <span>
                    {modelList.find((m) => m.id === model)?.name ??
                      (model || "未选模型")}
                  </span>
                  <span style={{ opacity: 0.5, marginLeft: 2 }}>▾</span>
                </button>
                {modelMenuOpen && (
                  <div
                    className="ai-model-menu ai-model-menu-up"
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
              </div>
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
                title={shortcutText("发送（⌘↩ 或 ↩）")}
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
            {shortcutText("⌘↩ 发送 · ⇧↩ 换行")}
          </span>
        </div>
      </div>
    </>
  );
}
