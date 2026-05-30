import { describe, expect, it } from "vitest";
import {
  isProviderAllowedInRegion,
  parseAIRegionMode,
  resolveAIRegion,
} from "./ai-region-policy";

describe("ai-region-policy", () => {
  it("parses build-time region modes", () => {
    expect(parseAIRegionMode("cn")).toBe("cn");
    expect(parseAIRegionMode("mainland")).toBe("cn");
    expect(parseAIRegionMode("global")).toBe("global");
    expect(parseAIRegionMode(undefined)).toBe("auto");
    expect(parseAIRegionMode("something-else")).toBe("auto");
  });

  it("resolves forced and auto regions", () => {
    expect(resolveAIRegion("cn", "global")).toBe("cn");
    expect(resolveAIRegion("global", "cn")).toBe("global");
    expect(resolveAIRegion("auto", "cn")).toBe("cn");
    expect(resolveAIRegion("auto", "global")).toBe("global");
  });

  it("blocks overseas AI providers in mainland region", () => {
    expect(isProviderAllowedInRegion("openai", "cn")).toBe(false);
    expect(isProviderAllowedInRegion("anthropic", "cn")).toBe(false);
    expect(isProviderAllowedInRegion("deepseek", "cn")).toBe(true);
    expect(isProviderAllowedInRegion("ollama", "cn")).toBe(true);
    expect(isProviderAllowedInRegion("openai", "global")).toBe(true);
  });
});
