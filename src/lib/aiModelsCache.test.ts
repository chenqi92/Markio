// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCached,
  getCached,
  getCachedAt,
  setCached,
} from "./aiModelsCache";

describe("aiModelsCache", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("roundtrips models per provider", () => {
    setCached("openai", [
      { id: "gpt-4o-mini" },
      { id: "gpt-4o", contextLength: 128000 },
    ]);
    const out = getCached("openai");
    expect(out).toHaveLength(2);
    expect(out?.[1].contextLength).toBe(128000);
    expect(getCached("anthropic")).toBeNull();
  });

  it("expires entries older than 24h", () => {
    setCached("openai", [{ id: "a" }]);
    expect(getCached("openai")).not.toBeNull();
    // 25 hours later
    vi.setSystemTime(new Date("2026-05-22T11:00:00Z"));
    expect(getCached("openai")).toBeNull();
  });

  it("returns null on malformed entries", () => {
    localStorage.setItem("markio.aiModels.v1:openai", "not json");
    expect(getCached("openai")).toBeNull();
  });

  it("exposes the cache timestamp for UI display", () => {
    setCached("openai", [{ id: "a" }]);
    const at = getCachedAt("openai");
    expect(at).toBeGreaterThan(0);
  });

  it("clears a single provider", () => {
    setCached("openai", [{ id: "a" }]);
    setCached("groq", [{ id: "b" }]);
    clearCached("openai");
    expect(getCached("openai")).toBeNull();
    expect(getCached("groq")).not.toBeNull();
  });
});
