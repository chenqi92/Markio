// AI 提供方目录：Settings / AIPanel / Rust 路由的"单一事实源"。
//   - 改这一个文件就能加 / 删 provider；新增 provider 还需在 src-tauri/src/ai.rs 的
//     call_openai_compat / stream_openai_compat 默认 endpoint match 里同步一行
//     （Anthropic 与 Google 走专有协议，其余走 OpenAI 兼容协议）。

import {
  filterProvidersForCurrentRegion,
  isMainlandAIRegion,
  isProviderAllowedInCurrentRegion,
  isSmartChannelModelSourceAllowed,
  MAINLAND_DEFAULT_AI_PROVIDER_ID,
} from "./ai-region-policy";

export type AIProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "ollama"
  | "nvidia"
  | "xai"
  | "groq"
  | "openrouter"
  | "siliconflow"
  | "zhipu"
  | "dashscope"
  | "moonshot"
  | "xiaomi"
  | "mistral"
  | "together"
  | "custom";

export interface AIProviderModel {
  id: string;
  name: string;
  tag: string;
}

export interface AIProviderDef {
  id: AIProviderId;
  /** 显示名 */
  name: string;
  /** 副标题：模型范围 / 适用场景 */
  sub: string;
  /** 默认 endpoint；Ollama 默认本地、custom 默认空串 */
  defaultEndpoint: string;
  /** 切到此 provider 时若 model 为空，回填这个 */
  defaultModel: string;
  /** API Key 输入框 placeholder */
  keyPlaceholder: string;
  /** Key 是否可选（仅 ollama 本地服务允许空） */
  keyOptional: boolean;
  /** AI 面板下拉的常用模型 */
  models: AIProviderModel[];
}

const MAINLAND_AI_PROVIDERS: AIProviderDef[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    sub: "V3 / R1 · 国内",
    defaultEndpoint: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", tag: "通用" },
      { id: "deepseek-reasoner", name: "DeepSeek R1", tag: "推理" },
    ],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow 硅基流动",
    sub: "国内聚合 · 多模型",
    defaultEndpoint: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B", tag: "默认 · 通用" },
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", tag: "通用" },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", tag: "推理" },
      { id: "meta-llama/Meta-Llama-3.1-70B-Instruct", name: "Llama 3.1 70B", tag: "开源" },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    sub: "GLM-4.6 / 4-Plus",
    defaultEndpoint: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    keyPlaceholder: "智谱 API Key",
    keyOptional: false,
    models: [
      { id: "glm-4-plus", name: "GLM-4 Plus", tag: "默认 · 推理" },
      { id: "glm-4-air", name: "GLM-4 Air", tag: "便宜" },
      { id: "glm-4-flash", name: "GLM-4 Flash", tag: "极便宜" },
      { id: "glm-4-long", name: "GLM-4 Long", tag: "长文档" },
    ],
  },
  {
    id: "dashscope",
    name: "通义千问 DashScope",
    sub: "阿里云 Qwen",
    defaultEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "qwen-plus", name: "Qwen Plus", tag: "默认 · 通用" },
      { id: "qwen-max", name: "Qwen Max", tag: "推理" },
      { id: "qwen-turbo", name: "Qwen Turbo", tag: "便宜 · 快" },
      { id: "qwen2.5-72b-instruct", name: "Qwen 2.5 72B", tag: "开源" },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    sub: "K1 / 长上下文",
    defaultEndpoint: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-32k",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "moonshot-v1-32k", name: "Moonshot v1 32K", tag: "默认" },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128K", tag: "长文档" },
      { id: "moonshot-v1-8k", name: "Moonshot v1 8K", tag: "便宜" },
    ],
  },
  {
    id: "xiaomi",
    name: "小米 MiMo",
    sub: "MiMo-V2.5 · 国内",
    defaultEndpoint: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.5-pro",
    keyPlaceholder: "MIMO_API_KEY",
    keyOptional: false,
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", tag: "默认 · 推理" },
      { id: "mimo-v2.5", name: "MiMo V2.5", tag: "多模态" },
      { id: "mimo-v2-flash", name: "MiMo V2 Flash", tag: "快速" },
    ],
  },
  {
    id: "ollama",
    name: "本地 · Ollama",
    sub: "Qwen / Llama",
    defaultEndpoint: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    keyPlaceholder: "本地服务可留空",
    keyOptional: true,
    models: [
      { id: "qwen2.5:14b", name: "Qwen 2.5 14B", tag: "本地 · 推荐" },
      { id: "llama3.2:3b", name: "Llama 3.2 3B", tag: "本地 · 轻量" },
    ],
  },
];

const ALL_AI_PROVIDERS: AIProviderDef[] =
  __MARKIO_AI_REGION__ === "cn" ? MAINLAND_AI_PROVIDERS : [
  {
    id: "anthropic",
    name: "Anthropic",
    sub: "Claude 系列",
    defaultEndpoint: "https://api.anthropic.com",
    defaultModel: "claude-haiku-4-5",
    keyPlaceholder: "sk-ant-…",
    keyOptional: false,
    models: [
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tag: "默认 · 最快" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", tag: "推理 · 长文档" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", tag: "复杂任务" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    sub: "GPT-4o / o-series",
    defaultEndpoint: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o mini", tag: "默认 · 便宜" },
      { id: "gpt-4o", name: "GPT-4o", tag: "通用" },
      { id: "o1-mini", name: "o1-mini", tag: "推理" },
      { id: "o3-mini", name: "o3-mini", tag: "推理 · 新" },
    ],
  },
  {
    id: "google",
    name: "Google",
    sub: "Gemini 2.5",
    defaultEndpoint: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-2.5-flash",
    keyPlaceholder: "AIza…",
    keyOptional: false,
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tag: "默认 · 快" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tag: "推理 · 长文档" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    sub: "V3 / R1 · 国内",
    defaultEndpoint: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", tag: "通用" },
      { id: "deepseek-reasoner", name: "DeepSeek R1", tag: "推理" },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    sub: "Llama / Mistral / Nemotron",
    defaultEndpoint: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    keyPlaceholder: "nvapi-…",
    keyOptional: false,
    models: [
      { id: "meta/llama-3.3-70b-instruct", name: "Llama 3.3 70B", tag: "默认 · 通用" },
      { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "Nemotron 70B", tag: "对齐强化" },
      { id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1 (NIM)", tag: "推理" },
      { id: "mistralai/mixtral-8x22b-instruct-v0.1", name: "Mixtral 8x22B", tag: "MoE" },
    ],
  },
  {
    id: "xai",
    name: "xAI Grok",
    sub: "Grok 4 / 3",
    defaultEndpoint: "https://api.x.ai/v1",
    defaultModel: "grok-4-latest",
    keyPlaceholder: "xai-…",
    keyOptional: false,
    models: [
      { id: "grok-4-latest", name: "Grok 4", tag: "默认 · 推理" },
      { id: "grok-3-mini", name: "Grok 3 mini", tag: "便宜" },
      { id: "grok-3", name: "Grok 3", tag: "通用" },
    ],
  },
  {
    id: "groq",
    name: "Groq Cloud",
    sub: "超低延迟推理",
    defaultEndpoint: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyPlaceholder: "gsk_…",
    keyOptional: false,
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", tag: "默认 · 极速" },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", tag: "便宜 · 极速" },
      { id: "deepseek-r1-distill-llama-70b", name: "R1 Distill 70B", tag: "推理" },
      { id: "qwen-2.5-32b", name: "Qwen 2.5 32B", tag: "中文" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    sub: "聚合 · 一 Key 跨厂商",
    defaultEndpoint: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-3.5-sonnet",
    keyPlaceholder: "sk-or-…",
    keyOptional: false,
    models: [
      { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", tag: "默认" },
      { id: "openai/gpt-4o-mini", name: "GPT-4o mini", tag: "便宜" },
      { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", tag: "快" },
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1", tag: "推理" },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", tag: "开源" },
    ],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow 硅基流动",
    sub: "国内聚合 · 多模型",
    defaultEndpoint: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "Qwen/Qwen2.5-72B-Instruct", name: "Qwen 2.5 72B", tag: "默认 · 通用" },
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", tag: "通用" },
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", tag: "推理" },
      { id: "meta-llama/Meta-Llama-3.1-70B-Instruct", name: "Llama 3.1 70B", tag: "开源" },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    sub: "GLM-4.6 / 4-Plus",
    defaultEndpoint: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    keyPlaceholder: "智谱 API Key",
    keyOptional: false,
    models: [
      { id: "glm-4-plus", name: "GLM-4 Plus", tag: "默认 · 推理" },
      { id: "glm-4-air", name: "GLM-4 Air", tag: "便宜" },
      { id: "glm-4-flash", name: "GLM-4 Flash", tag: "极便宜" },
      { id: "glm-4-long", name: "GLM-4 Long", tag: "长文档" },
    ],
  },
  {
    id: "dashscope",
    name: "通义千问 DashScope",
    sub: "阿里云 Qwen",
    defaultEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "qwen-plus", name: "Qwen Plus", tag: "默认 · 通用" },
      { id: "qwen-max", name: "Qwen Max", tag: "推理" },
      { id: "qwen-turbo", name: "Qwen Turbo", tag: "便宜 · 快" },
      { id: "qwen2.5-72b-instruct", name: "Qwen 2.5 72B", tag: "开源" },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    sub: "K1 / 长上下文",
    defaultEndpoint: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-32k",
    keyPlaceholder: "sk-…",
    keyOptional: false,
    models: [
      { id: "moonshot-v1-32k", name: "Moonshot v1 32K", tag: "默认" },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128K", tag: "长文档" },
      { id: "moonshot-v1-8k", name: "Moonshot v1 8K", tag: "便宜" },
    ],
  },
  {
    id: "xiaomi",
    name: "小米 MiMo",
    sub: "MiMo-V2.5",
    defaultEndpoint: "https://api.xiaomimimo.com/v1",
    defaultModel: "mimo-v2.5-pro",
    keyPlaceholder: "MIMO_API_KEY",
    keyOptional: false,
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", tag: "默认 · 推理" },
      { id: "mimo-v2.5", name: "MiMo V2.5", tag: "多模态" },
      { id: "mimo-v2-flash", name: "MiMo V2 Flash", tag: "快速" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    sub: "Mistral Large / Codestral",
    defaultEndpoint: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    keyPlaceholder: "Mistral API Key",
    keyOptional: false,
    models: [
      { id: "mistral-large-latest", name: "Mistral Large", tag: "默认 · 通用" },
      { id: "mistral-small-latest", name: "Mistral Small", tag: "便宜" },
      { id: "codestral-latest", name: "Codestral", tag: "代码" },
    ],
  },
  {
    id: "together",
    name: "Together AI",
    sub: "开源模型托管",
    defaultEndpoint: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyPlaceholder: "Together API Key",
    keyOptional: false,
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo", tag: "默认" },
      { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", tag: "通用" },
      { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", name: "Qwen 2.5 72B Turbo", tag: "中文" },
    ],
  },
  {
    id: "ollama",
    name: "本地 · Ollama",
    sub: "Qwen / Llama / Mistral",
    defaultEndpoint: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    keyPlaceholder: "本地服务可留空",
    keyOptional: true,
    models: [
      { id: "qwen2.5:14b", name: "Qwen 2.5 14B", tag: "本地 · 推荐" },
      { id: "llama3.2:3b", name: "Llama 3.2 3B", tag: "本地 · 轻量" },
      { id: "mistral:7b", name: "Mistral 7B", tag: "本地 · 通用" },
    ],
  },
  {
    id: "custom",
    name: "自定义",
    sub: "OpenAI 兼容 endpoint",
    defaultEndpoint: "",
    defaultModel: "",
    keyPlaceholder: "API Key",
    keyOptional: false,
    models: [],
  },
];

function computeAIProviders(): AIProviderDef[] {
  return filterProvidersForCurrentRegion(ALL_AI_PROVIDERS);
}

export let AI_PROVIDERS: AIProviderDef[] = computeAIProviders();

export function refreshAIProvidersForCurrentRegion(): void {
  AI_PROVIDERS = computeAIProviders();
}

export function getAIProviders(): AIProviderDef[] {
  refreshAIProvidersForCurrentRegion();
  return AI_PROVIDERS;
}

const ALL_PROVIDER_INDEX: Record<string, AIProviderDef> = ALL_AI_PROVIDERS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<string, AIProviderDef>,
);

function providerIndex(): Record<string, AIProviderDef> {
  return getAIProviders().reduce(
    (acc, p) => {
      acc[p.id] = p;
      return acc;
    },
    {} as Record<string, AIProviderDef>,
  );
}

function isKnownProviderId(id: string): id is AIProviderId {
  return id in ALL_PROVIDER_INDEX;
}

export function getProvider(id: string): AIProviderDef | undefined {
  return providerIndex()[id];
}

export function getProviderModels(id: string): AIProviderModel[] {
  return providerIndex()[id]?.models ?? [];
}

export function getProviderDefaults(id: string): {
  endpoint: string;
  model: string;
} {
  const p = providerIndex()[id];
  return {
    endpoint: p?.defaultEndpoint ?? "",
    model: p?.defaultModel ?? "",
  };
}

export function getDefaultAIProviderId(): AIProviderId {
  if (isMainlandAIRegion()) return MAINLAND_DEFAULT_AI_PROVIDER_ID;
  return getAIProviders()[0]?.id ?? MAINLAND_DEFAULT_AI_PROVIDER_ID;
}

export function getDefaultAIProviderDefaults(): {
  provider: AIProviderId;
  endpoint: string;
  model: string;
  label: string;
} {
  const provider = getDefaultAIProviderId();
  const def = getProvider(provider) ?? ALL_PROVIDER_INDEX[provider];
  return {
    provider,
    endpoint: def?.defaultEndpoint ?? "",
    model: def?.defaultModel ?? "",
    label: def?.name ?? provider,
  };
}

export interface AIRegionSanitizableState {
  aiProvider: AIProviderId;
  aiEndpoint: string;
  aiModel: string;
  aiProviderConfigs: Partial<Record<AIProviderId, { endpoint?: string; model?: string }>>;
  aiSources: Array<{ provider: AIProviderId; label: string; endpoint?: string }>;
  smartChannelModelSource?: "aiDefault" | "deepCurrent" | "fastCurrent" | "localOllama";
  ragEmbedSource?: AIProviderId | "ollama";
  ragEmbedBaseUrl?: string;
  ragEmbedModel?: string;
  ragEmbedDim?: number;
}

function providerLabel(id: AIProviderId): string {
  return getProvider(id)?.name ?? ALL_PROVIDER_INDEX[id]?.name ?? id;
}

function makeSource(id: AIProviderId): AIRegionSanitizableState["aiSources"][number] {
  return { provider: id, label: providerLabel(id) };
}

function sourcesEqual(
  a: AIRegionSanitizableState["aiSources"],
  b: AIRegionSanitizableState["aiSources"],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (src, index) =>
        src.provider === b[index]?.provider &&
        src.label === b[index]?.label &&
        src.endpoint === b[index]?.endpoint,
    )
  );
}

export function sanitizeAIStateForCurrentRegion(
  state: AIRegionSanitizableState,
): Partial<AIRegionSanitizableState> | null {
  if (!isMainlandAIRegion()) return null;

  const patch: Partial<AIRegionSanitizableState> = {};
  const keptSources = state.aiSources
    .filter(
      (src) =>
        isKnownProviderId(src.provider) &&
        isProviderAllowedInCurrentRegion(src.provider),
    )
    .map((src) => ({
      ...src,
      label: providerLabel(src.provider),
    }));

  const defaultProvider = getDefaultAIProviderId();
  const nextSources = keptSources.length > 0 ? keptSources : [makeSource(defaultProvider)];
  const currentAllowed =
    isKnownProviderId(state.aiProvider) &&
    isProviderAllowedInCurrentRegion(state.aiProvider);
  const nextProvider = currentAllowed ? state.aiProvider : nextSources[0]!.provider;

  if (!nextSources.some((src) => src.provider === nextProvider)) {
    nextSources.unshift(makeSource(nextProvider));
  }

  if (!sourcesEqual(state.aiSources, nextSources)) {
    patch.aiSources = nextSources;
  }

  if (state.aiProvider !== nextProvider) {
    const saved = state.aiProviderConfigs[nextProvider] ?? {};
    const defaults = getProviderDefaults(nextProvider);
    patch.aiProvider = nextProvider;
    patch.aiEndpoint = saved.endpoint ?? defaults.endpoint;
    patch.aiModel = saved.model ?? defaults.model;
  }

  if (
    state.smartChannelModelSource &&
    !isSmartChannelModelSourceAllowed(state.smartChannelModelSource)
  ) {
    patch.smartChannelModelSource = "aiDefault";
  }

  if (
    state.ragEmbedSource &&
    state.ragEmbedSource !== "ollama" &&
    (!isKnownProviderId(state.ragEmbedSource) ||
      !isProviderAllowedInCurrentRegion(state.ragEmbedSource))
  ) {
    patch.ragEmbedSource = "ollama";
    patch.ragEmbedBaseUrl = "http://127.0.0.1:11434";
    patch.ragEmbedModel = "nomic-embed-text";
    patch.ragEmbedDim = 768;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
