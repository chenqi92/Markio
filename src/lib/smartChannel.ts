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
import {
  isProviderAllowedInCurrentRegion,
  isSmartChannelModelSourceAllowed,
} from "@/lib/ai-region-policy";
import type { AIProviderId } from "@/lib/ai-providers";

export type SmartChannelScope = "currentFile" | "currentWorkspace" | "allWorkspaces";
export type SmartChannelModelSource =
  | "aiDefault"
  | "deepCurrent"
  | "fastCurrent"
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
  deepCurrent: "深度模式（当前账户）",
  fastCurrent: "快速模式（当前账户）",
  localOllama: "本地 Ollama",
};

const DEEP_CURRENT_MODEL =
  __MARKIO_AI_REGION__ === "cn"
    ? null
    : ({ provider: "anthropic", model: "claude-haiku-4-5" } as const);

const FAST_CURRENT_MODEL =
  __MARKIO_AI_REGION__ === "cn"
    ? null
    : ({ provider: "openai", model: "gpt-4o-mini" } as const);

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

/**
 * 原子预占一个配额名额：read-check-write 全程同步（无 await），JS 单线程内不可被打断，
 * 因此并发查询不会都通过检查再各自 +1 而越过上限。调用失败时用 releaseSmartChannelQuota 回滚。
 * 注：localStorage 仍可被页面脚本篡改重置；彻底的防篡改配额需移到后端（见文末 TODO）。
 */
function reserveSmartChannelQuota(): { allowed: boolean; used: number; limit: number } {
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
  if (used >= limit) return { allowed: false, used, limit };
  used += 1;
  try {
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({ date: today, used } satisfies QuotaRecord),
    );
  } catch {
    /* ignore */
  }
  return { allowed: true, used, limit };
}

/** 预占后调用失败时回滚一个名额（仅当仍是今日记录时）。 */
function releaseSmartChannelQuota(): void {
  const today = todayKey();
  try {
    const raw = localStorage.getItem(QUOTA_KEY);
    if (!raw) return;
    const rec = JSON.parse(raw) as QuotaRecord;
    if (rec.date !== today) return;
    const used = Math.max(0, rec.used - 1);
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({ date: today, used } satisfies QuotaRecord),
    );
  } catch {
    /* ignore */
  }
}

function resolveProviderModel(src: SmartChannelModelSource): {
  provider: AIProviderId;
  model: string;
  endpoint?: string;
} {
  const s = useSettings.getState();
  const safeSource = isSmartChannelModelSourceAllowed(src) ? src : "aiDefault";
  switch (safeSource) {
    case "deepCurrent":
      return DEEP_CURRENT_MODEL ?? {
        provider: "ollama",
        model: "qwen2.5:14b",
        endpoint: "http://127.0.0.1:11434/v1",
      };
    case "fastCurrent":
      return FAST_CURRENT_MODEL ?? {
        provider: "ollama",
        model: "qwen2.5:14b",
        endpoint: "http://127.0.0.1:11434/v1",
      };
    case "localOllama":
      return {
        provider: "ollama",
        model: s.aiProvider === "ollama" ? s.aiModel : "qwen2.5:14b",
        endpoint: s.aiProvider === "ollama" && s.aiEndpoint ? s.aiEndpoint : undefined,
      };
    case "aiDefault":
    default:
      if (!isProviderAllowedInCurrentRegion(s.aiProvider)) {
        return {
          provider: "ollama",
          model: "qwen2.5:14b",
          endpoint: "http://127.0.0.1:11434/v1",
        };
      }
      return {
        provider: s.aiProvider,
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
          settings.ragEmbedSource === "ollama"
            ? {
                provider: "ollama",
                model: settings.ragEmbedModel,
                dim: settings.ragEmbedDim,
                baseUrl: settings.ragEmbedBaseUrl,
              }
            : {
                provider: "openai",
                model: settings.ragEmbedModel,
                dim: settings.ragEmbedDim,
                baseUrl: settings.ragEmbedBaseUrl,
                keyProvider: settings.ragEmbedSource,
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
  // 先原子预占名额，再做检索/调用；失败回滚，避免并发越过上限。
  const quota = reserveSmartChannelQuota();
  if (!quota.allowed) {
    throw new Error(
      `今日智能通道调用已达上限（${quota.limit} 次），明天再来或在设置中调高上限。`,
    );
  }

  try {
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

    const ws = useWorkspace.getState().activeWorkspace();
    return {
      answer: result.text,
      refs,
      workspace: scope === "allWorkspaces" ? "allWorkspaces" : ws?.path,
      model: result.model ?? model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  } catch (e) {
    releaseSmartChannelQuota();
    throw e;
  }
}

/**
 * 暴露给开发者控制台 / 外部桥（Tauri 命令尚未挂上时的临时入口）。
 *
 * 现在受 smartChannelEnabled 设置 gate：关闭时不挂全局，避免在不打算用此功能
 * 的设备上把内部 API 暴露给页面里的任意脚本 / 浏览器 devtools 探测。设置切换
 * 时通过 useSettings.subscribe 同步增删。
 *
 * TODO: 正式的 Tauri command + permission model 出来后整体移除此全局。
 */
declare global {
  interface Window {
    __markioSmartChannel?: {
      query: (q: string, opts?: Omit<SmartChannelRequest, "query">) => Promise<SmartChannelResponse>;
      usage: () => ReturnType<typeof getSmartChannelUsage>;
      id: () => string;
    };
  }
}

function syncSmartChannelGlobal(enabled: boolean) {
  if (typeof window === "undefined") return;
  if (enabled) {
    window.__markioSmartChannel = {
      query: (q, opts) => smartChannelQuery({ query: q, ...opts }),
      usage: getSmartChannelUsage,
      id: () => useSettings.getState().smartChannelId,
    };
  } else {
    delete window.__markioSmartChannel;
  }
}

if (typeof window !== "undefined") {
  syncSmartChannelGlobal(useSettings.getState().smartChannelEnabled);
  useSettings.subscribe((state, prev) => {
    if (state.smartChannelEnabled !== prev.smartChannelEnabled) {
      syncSmartChannelGlobal(state.smartChannelEnabled);
    }
  });
}
