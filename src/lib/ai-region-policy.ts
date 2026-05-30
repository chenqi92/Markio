import type { AIProviderId } from "./ai-providers";

export type AIRegionMode = "auto" | "cn" | "global";
export type AIRegion = "cn" | "global";

export const MAINLAND_AI_PROVIDER_IDS = [
  "deepseek",
  "siliconflow",
  "zhipu",
  "dashscope",
  "moonshot",
  "ollama",
] as const satisfies readonly AIProviderId[];

const MAINLAND_AI_PROVIDER_SET: ReadonlySet<AIProviderId> = new Set(
  MAINLAND_AI_PROVIDER_IDS,
);

export const MAINLAND_DEFAULT_AI_PROVIDER_ID: AIProviderId = "ollama";

export const MAINLAND_AI_COMPLIANCE_NOTICE =
  "当前按中国大陆合规策略运行：境外未备案模型服务入口已隐藏，仅保留本地模型与国内模型源。";

const MAINLAND_TIME_ZONES = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Harbin",
  "Asia/Urumqi",
]);

export function parseAIRegionMode(value: string | undefined): AIRegionMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["cn", "china", "mainland", "mainland-cn"].includes(normalized)) {
    return "cn";
  }
  if (["global", "intl", "international", "overseas"].includes(normalized)) {
    return "global";
  }
  return "auto";
}

export function getConfiguredAIRegionMode(): AIRegionMode {
  return parseAIRegionMode(__MARKIO_AI_REGION__);
}

function localeHasMainlandRegion(locale: string): boolean {
  try {
    return new Intl.Locale(locale).region?.toUpperCase() === "CN";
  } catch {
    const normalized = locale.replace(/_/g, "-").toLowerCase();
    return normalized === "zh-cn" || normalized.endsWith("-cn");
  }
}

export function detectRuntimeAIRegion(): AIRegion {
  if (typeof navigator !== "undefined") {
    const languages =
      navigator.languages && navigator.languages.length > 0
        ? navigator.languages
        : navigator.language
          ? [navigator.language]
          : [];
    if (languages.some(localeHasMainlandRegion)) return "cn";
  }

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (MAINLAND_TIME_ZONES.has(timeZone)) return "cn";
  } catch {
    /* ignore */
  }

  return "global";
}

export function resolveAIRegion(
  mode: AIRegionMode,
  runtimeRegion: AIRegion,
): AIRegion {
  if (mode === "cn") return "cn";
  if (mode === "global") return "global";
  return runtimeRegion;
}

export function getAIRegionPolicy(): {
  mode: AIRegionMode;
  region: AIRegion;
  forced: boolean;
} {
  const mode = getConfiguredAIRegionMode();
  return {
    mode,
    region: resolveAIRegion(mode, detectRuntimeAIRegion()),
    forced: mode !== "auto",
  };
}

export function isMainlandAIRegion(): boolean {
  return getAIRegionPolicy().region === "cn";
}

export function isProviderAllowedInRegion(
  id: AIProviderId,
  region: AIRegion,
): boolean {
  return region === "global" || MAINLAND_AI_PROVIDER_SET.has(id);
}

export function isProviderAllowedInCurrentRegion(id: AIProviderId): boolean {
  return isProviderAllowedInRegion(id, getAIRegionPolicy().region);
}

export function filterProvidersForCurrentRegion<T extends { id: AIProviderId }>(
  providers: readonly T[],
): T[] {
  const region = getAIRegionPolicy().region;
  return providers.filter((provider) =>
    isProviderAllowedInRegion(provider.id, region),
  );
}

export function isExternalAgentAllowedInCurrentRegion(): boolean {
  return !isMainlandAIRegion();
}

export function isSmartChannelModelSourceAllowed(source: string): boolean {
  if (!isMainlandAIRegion()) return true;
  return source === "aiDefault" || source === "localOllama";
}
