/**
 * 智能通道（Smart Channel）
 *
 * 作用：把当前文档工具（markio）的内容暴露成一个可被其他客户端调用的查询通道。
 * - 外部 app（命令面板、Raycast / Alfred 扩展、微信助手机器人、第三方 webhook 等）
 *   通过 `smartChannelQuery` 提交一个自然语言问题；
 * - 通道按 `smartChannelScope` 在仓库里检索（向量索引优先，缺省时退化到关键词 grep）；
 * - 取命中片段拼成上下文，按 `smartChannelModelSource` 选择模型走 `ai_chat`，
 *   返回结构化结果（answer + refs + 用量），供调用方渲染。
 *
 * 后续 Rust 端如果挂上 `smart_channel_invoke` 命令，外部 app 只需把 channelId 一起
 * 传入即可触发本函数；目前对前端可用的入口：
 *   1. 设置 → 智能通道 中的"提问测试"按钮（本组件即用即试）；
 *   2. 命令面板里的"通过智能通道查询当前仓库"动作（CommandPalette 注入）。
 */

import { api, type RagHit, type RagEmbedConfig } from "@/lib/api";
import { useSettings } from "@/stores/settings";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { reportDiagnostic } from "@/stores/diagnostics";

export type SmartChannelScope = "currentFile" | "currentWorkspace" | "allWorkspaces";
export type SmartChannelModelSource =
  | "aiDefault"
  | "currentClaude"
  | "currentOpenAI"
  | "localOllama";

export interface SmartChannelHit {
  path: string;
  workspace?: string;
  heading: string;
  snippet: string;
  score: number;
  source: string;
}

export interface SmartChannelRequest {
  /** 自然语言问题 */
  query: string;
  /** 覆盖默认 scope（可选） */
  scope?: SmartChannelScope;
  /** 覆盖默认模型来源（可选） */
  modelSource?: SmartChannelModelSource;
  /** 检索返回的最大片段数（覆盖设置） */
  maxChunks?: number;
}

export interface SmartChannelResponse {
  answer: string;
  refs: SmartChannelHit[];
  /** 命中的工作空间 */
  workspace?: string;
  /** 实际使用的模型 */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const STYLE_PROMPT: Record<
  ReturnType<typeof useSettings.getState>["smartChannelResponseStyle"],
  string
> = {
  concise: "用 3 句话以内的中文回答，给出结论，必要时附 1 个引用文件名。",
  balanced:
    "用 markdown 给出结构化中文答案：先一句话结论，再列出关键要点（不超过 5 条），最后用引用块（>）标出最相关的文件路径与小节。",
  detailed:
    "用 markdown 给出尽可能完整的中文答案：开头一段总述，然后分小标题展开，引用文件路径与小节，必要时给出原文摘录。",
};

const MODEL_SOURCE_LABEL: Record<SmartChannelModelSource, string> = {
  aiDefault: "AI 助手默认",
  currentClaude: "Claude（当前账户）",
  currentOpenAI: "OpenAI（当前账户）",
  localOllama: "本地 Ollama",
};

export function smartChannelModelLabel(src: SmartChannelModelSource): string {
  return MODEL_SOURCE_LABEL[src];
}

/** 取每日上限的本地配额；超出后拒绝再次调用 */
const QUOTA_KEY = "markio.smartChannel.quota.v1";

interface QuotaRecord {
  date: string; // YYYY-MM-DD
  used: number;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getSmartChannelUsage(): { date: string; used: number; limit: number } {
  const limit = useSettings.getState().smartChannelDailyLimit;
  let rec: QuotaRecord | null = null;
  try {
    const raw = localStorage.getItem(QUOTA_KEY);
    if (raw) rec = JSON.parse(raw) as QuotaRecord;
  } catch {
    rec = null;
  }
  const today = todayKey();
  if (!rec || rec.date !== today) {
    return { date: today, used: 0, limit };
  }
  return { date: rec.date, used: rec.used, limit };
}

function hasSmartChannelQuota(): { used: number; limit: number; allowed: boolean } {
  const limit = useSettings.getState().smartChannelDailyLimit;
  const usage = getSmartChannelUsage();
  return { used: usage.used, limit, allowed: usage.used < limit };
}

function incrementSmartChannelUsage(): { used: number; limit: number } {
  const limit = useSettings.getState().smartChannelDailyLimit;
  const today = todayKey();
  let used = 0;
  try {
    const raw = localStorage.getItem(QUOTA_KEY);
    if (raw) {
      const rec = JSON.parse(raw) as QuotaRecord;
      if (rec.date === today) used = rec.used;
    }
  } catch {
    /* ignore */
  }
  used += 1;
  try {
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({ date: today, used } satisfies QuotaRecord),
    );
  } catch {
    /* ignore */
  }
  return { used, limit };
}

function resolveProviderModel(src: SmartChannelModelSource): {
  provider: "anthropic" | "openai" | "deepseek" | "ollama" | "google" | "custom";
  model: string;
  endpoint?: string;
} {
  const s = useSettings.getState();
  switch (src) {
    case "currentClaude":
      return { provider: "anthropic", model: "claude-haiku-4-5" };
    case "currentOpenAI":
      return { provider: "openai", model: "gpt-4o-mini" };
    case "localOllama":
      return {
        provider: "ollama",
        model: s.aiProvider === "ollama" ? s.aiModel : "qwen2.5:14b",
        endpoint: s.aiProvider === "ollama" && s.aiEndpoint ? s.aiEndpoint : undefined,
      };
    case "aiDefault":
    default:
      return {
        provider: s.aiProvider === "custom" ? "openai" : (s.aiProvider as "anthropic"),
        model: s.aiModel,
        endpoint: s.aiEndpoint || undefined,
      };
  }
}

async function retrieve(
  scope: SmartChannelScope,
  query: string,
  maxChunks: number,
): Promise<SmartChannelHit[]> {
  if (scope === "currentFile") {
    const tab = useTabs.getState().activeTab();
    if (!tab) return [];
    // 在当前文档里做简单的关键词匹配，按段切片
    const paras = tab.content.split(/\n\s*\n/);
    const lower = query.toLowerCase();
    const hits: SmartChannelHit[] = [];
    paras.forEach((p, i) => {
      if (hits.length >= maxChunks) return;
      if (p.toLowerCase().includes(lower)) {
        hits.push({
          path: tab.path,
          workspace: useWorkspace.getState().activeWorkspace()?.path,
          heading: `段落 #${i + 1}`,
          snippet: p.slice(0, 600),
          score: 1,
          source: "currentFile",
        });
      }
    });
    return hits;
  }

  const workspaceState = useWorkspace.getState();
  const active = workspaceState.activeWorkspace();
  const targets =
    scope === "allWorkspaces"
      ? workspaceState.workspaces.filter((w) => !workspaceState.isUnavailable(w.path))
      : active
        ? [active]
        : [];
  if (targets.length === 0) return [];

  const settings = useSettings.getState();

  const retrieveWorkspace = async (
    workspacePath: string,
    workspaceName: string,
  ): Promise<SmartChannelHit[]> => {
    // 历史仓库在启动时不会全部注册；跨仓库检索前先按需注册。
    try {
      await api.workspaceRegister(workspacePath);
    } catch (e) {
      reportDiagnostic({
        source: "smart-channel",
        severity: "warning",
        message: "智能通道仓库注册失败，已跳过该仓库",
        detail: e,
        workspace: workspacePath,
      });
      return [];
    }

    const attachmentHits = async (remaining: number): Promise<SmartChannelHit[]> => {
      if (!settings.smartChannelIncludeAttachments || remaining <= 0) return [];
      try {
        const queryLower = query.toLowerCase();
        const attachments = await api.listAttachments(workspacePath, 200);
        return attachments
          .filter((a) => a.name.toLowerCase().includes(queryLower))
          .slice(0, remaining)
          .map((a) => ({
            path: a.path,
            workspace: workspacePath,
            heading: "附件",
            snippet: `附件：${a.name}\n类型：${a.kind}\n大小：${Math.round(a.size / 1024)} KB\n仓库：${workspaceName}`,
            score: 0,
            source: "attachment",
          }));
      } catch (e) {
        reportDiagnostic({
          source: "smart-channel",
          severity: "warning",
          message: "智能通道附件元信息检索失败",
          detail: e,
          workspace: workspacePath,
        });
        return [];
      }
    };

    // 优先走向量索引
    if (settings.ragEnabled) {
      try {
        const cfg: RagEmbedConfig =
          settings.ragProvider === "ollama"
            ? {
                provider: "ollama",
                model: settings.ragOllamaModel,
                dim: settings.ragOllamaDim,
                baseUrl: settings.ragOllamaBaseUrl,
              }
            : {
                provider: "openai",
                model: settings.ragOpenaiModel,
                dim: settings.ragOpenaiDim,
                baseUrl: settings.ragOpenaiBaseUrl,
              };
        const ragHits: RagHit[] = await api.ragSearch({
          workspace: workspacePath,
          query,
          limit: maxChunks,
          expandLinks: settings.ragExpandLinks,
          config: cfg,
        });
        if (ragHits.length > 0) {
          const hits = ragHits.map((h) => ({
            path: h.path,
            workspace: workspacePath,
            heading: h.heading,
            snippet: h.body,
            score: h.score,
            source: "rag",
          }));
          return [
            ...hits,
            ...(await attachmentHits(Math.max(0, maxChunks - hits.length))),
          ];
        }
      } catch (e) {
        reportDiagnostic({
          source: "smart-channel",
          severity: "warning",
          message: "智能通道向量检索失败，已退回关键词检索",
          detail: e,
          workspace: workspacePath,
        });
      }
    }

    // 关键词检索兜底
    try {
      const grepHits = await api.aiRetrieve(workspacePath, query, maxChunks);
      const hits = grepHits.map((h) => ({
        path: h.path,
        workspace: workspacePath,
        heading: h.line ? `第 ${h.line} 行` : "",
        snippet: h.snippet,
        score: 0,
        source: "grep",
      }));
      return [
        ...hits,
        ...(await attachmentHits(Math.max(0, maxChunks - hits.length))),
      ];
    } catch (e) {
      reportDiagnostic({
        source: "smart-channel",
        severity: "warning",
        message: "智能通道关键词检索失败",
        detail: e,
        workspace: workspacePath,
      });
      return [];
    }
  };

  const batches = await Promise.all(
    targets.map((w) => retrieveWorkspace(w.path, w.name)),
  );
  return batches
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);
}

export async function smartChannelQuery(
  req: SmartChannelRequest,
): Promise<SmartChannelResponse> {
  const s = useSettings.getState();
  if (!s.smartChannelEnabled) {
    throw new Error("智能通道未启用，请到 设置 → 智能通道 中开启。");
  }
  const quota = hasSmartChannelQuota();
  if (!quota.allowed) {
    throw new Error(
      `今日智能通道调用已达上限（${quota.limit} 次），明天再来或在设置中调高上限。`,
    );
  }

  const scope = req.scope ?? s.smartChannelScope;
  const modelSource = req.modelSource ?? s.smartChannelModelSource;
  const maxChunks = req.maxChunks ?? s.smartChannelMaxChunks;

  const refs = await retrieve(scope, req.query, maxChunks);
  const { provider, model, endpoint } = resolveProviderModel(modelSource);

  const ctxBlock = refs
    .map((h, i) => {
      const file = h.path.split("/").slice(-1)[0] ?? h.path;
      const workspace = h.workspace ? `\n仓库：${h.workspace}` : "";
      const heading = h.heading ? `\n小节：${h.heading}` : "";
      return `### 片段 ${i + 1} · ${file}（${h.source}）${workspace}${heading}\n${h.snippet}`;
    })
    .join("\n\n---\n\n");

  const systemParts = [
    "你是 markio 文档库的智能通道，会基于用户的本地笔记库回答问题。",
    STYLE_PROMPT[s.smartChannelResponseStyle],
    '若提供了片段，请只依据片段回答；片段不足以回答时直接说"未检索到相关内容"，不要编造。',
  ];
  if (ctxBlock) {
    systemParts.push(`仓库相关片段：\n\n${ctxBlock}`);
  }

  const result = await api.aiChat({
    provider,
    endpoint,
    model,
    maxTokens: 800,
    temperature: 0.2,
    system: systemParts.join("\n\n"),
    messages: [{ role: "user", content: req.query }],
  });
  incrementSmartChannelUsage();

  const ws = useWorkspace.getState().activeWorkspace();
  return {
    answer: result.text,
    refs,
    workspace: scope === "allWorkspaces" ? "allWorkspaces" : ws?.path,
    model: result.model ?? model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

/** 暴露给开发者控制台 / 外部桥（Tauri 命令尚未挂上时的临时入口） */
declare global {
  interface Window {
    __markioSmartChannel?: {
      query: (q: string, opts?: Omit<SmartChannelRequest, "query">) => Promise<SmartChannelResponse>;
      usage: () => ReturnType<typeof getSmartChannelUsage>;
      id: () => string;
    };
  }
}

if (typeof window !== "undefined") {
  window.__markioSmartChannel = {
    query: (q, opts) => smartChannelQuery({ query: q, ...opts }),
    usage: getSmartChannelUsage,
    id: () => useSettings.getState().smartChannelId,
  };
}
