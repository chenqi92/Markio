import type { AIProviderId } from "./ai-providers";

export type AIRegionMode = "auto" | "cn" | "global";
export type AIRegion = "cn" | "global";
export type AIRegionSource = "build" | "storefront" | "runtime";

export const MAINLAND_AI_PROVIDER_IDS = [
  "deepseek",
  "siliconflow",
  "zhipu",
  "dashscope",
  "moonshot",
  "xiaomi",
  "ollama",
] as const satisfies readonly AIProviderId[];

const MAINLAND_AI_PROVIDER_SET: ReadonlySet<AIProviderId> = new Set(
  MAINLAND_AI_PROVIDER_IDS,
);

export const MAINLAND_DEFAULT_AI_PROVIDER_ID: AIProviderId = "ollama";

export const MAINLAND_AI_COMPLIANCE_NOTICE =
  "当前版本仅支持本地模型与可用模型源，请在设置中选择可用模型源。";

const MAINLAND_TIME_ZONES = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Harbin",
  "Asia/Urumqi",
]);

const MAINLAND_STOREFRONT_CODES = new Set([
  "CN",
  "CHN",
  "156",
  "CHINA",
  "MAINLAND",
]);

let runtimeAIRegionOverride: {
  region: AIRegion;
  source: AIRegionSource;
  countryCode?: string | null;
} | null = null;

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

export function storefrontCountryCodeToAIRegion(
  countryCode: string | null | undefined,
): AIRegion | null {
  const normalized = (countryCode ?? "").trim().toUpperCase();
  if (!normalized) return null;
  return MAINLAND_STOREFRONT_CODES.has(normalized) ? "cn" : "global";
}

export function setRuntimeAIRegionOverride(
  region: AIRegion | null,
  source: AIRegionSource = "runtime",
  countryCode?: string | null,
): void {
  runtimeAIRegionOverride = region ? { region, source, countryCode } : null;
}

export function setRuntimeAIRegionFromStorefront(
  countryCode: string | null | undefined,
): AIRegion | null {
  const region = storefrontCountryCodeToAIRegion(countryCode);
  if (region) {
    setRuntimeAIRegionOverride(region, "storefront", countryCode ?? null);
  }
  return region;
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
  if (runtimeAIRegionOverride) return runtimeAIRegionOverride.region;

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
  source: AIRegionSource;
  countryCode?: string | null;
} {
  const mode = getConfiguredAIRegionMode();
  const runtimeRegion = detectRuntimeAIRegion();
  const forced = mode !== "auto";
  if (!forced && runtimeAIRegionOverride) {
    return {
      mode,
      region: runtimeRegion,
      forced,
      source: runtimeAIRegionOverride.source,
      countryCode: runtimeAIRegionOverride.countryCode,
    };
  }
  return {
    mode,
    region: resolveAIRegion(mode, runtimeRegion),
    forced,
    source: forced ? "build" : "runtime",
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
