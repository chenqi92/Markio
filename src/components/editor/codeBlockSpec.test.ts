import { describe, expect, it } from "vitest";
import { normalizeCodeBlockLanguage } from "./codeBlockSpec";

describe("normalizeCodeBlockLanguage", () => {
  it("normalizes common fenced-code aliases to selectable languages", () => {
    expect(normalizeCodeBlockLanguage("ts")).toBe("typescript");
    expect(normalizeCodeBlockLanguage("js")).toBe("javascript");
    expect(normalizeCodeBlockLanguage("py")).toBe("python");
    expect(normalizeCodeBlockLanguage("sh")).toBe("shellscript");
    expect(normalizeCodeBlockLanguage("yml")).toBe("yaml");
    expect(normalizeCodeBlockLanguage("golang")).toBe("go");
  });

  it("uses the first token and preserves unknown languages", () => {
    expect(normalizeCodeBlockLanguage("typescript title=\"demo\"")).toBe("typescript");
    expect(normalizeCodeBlockLanguage("custom-lang")).toBe("custom-lang");
  });

  it("falls back to plain text when no language is set", () => {
    expect(normalizeCodeBlockLanguage("")).toBe("text");
    expect(normalizeCodeBlockLanguage(null)).toBe("text");
  });
});
