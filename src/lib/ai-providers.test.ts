import { afterEach, describe, expect, it } from "vitest";
import {
  getAIProviders,
  refreshAIProvidersForCurrentRegion,
} from "./ai-providers";
import { setRuntimeAIRegionOverride } from "./ai-region-policy";

describe("ai-providers runtime region", () => {
  afterEach(() => {
    setRuntimeAIRegionOverride(null);
    refreshAIProvidersForCurrentRegion();
  });

  it("filters providers from the StoreKit-derived runtime region", () => {
    setRuntimeAIRegionOverride("cn", "storefront", "CHN");
    refreshAIProvidersForCurrentRegion();

    const mainlandIds = getAIProviders().map((provider) => provider.id);
    expect(mainlandIds).toContain("deepseek");
    expect(mainlandIds).toContain("xiaomi");
    expect(mainlandIds).not.toContain("openai");
    expect(mainlandIds).not.toContain("openrouter");

    setRuntimeAIRegionOverride("global", "storefront", "USA");
    refreshAIProvidersForCurrentRegion();
    expect(getAIProviders().map((provider) => provider.id)).toContain("openai");
  });
});
