import { describe, expect, it } from "vitest";
import { pathContains, samePath } from "./utils";

describe("path helpers", () => {
  it("matches equal paths with slash and case normalization where appropriate", () => {
    expect(samePath("/vault/imports/", "/vault/imports")).toBe(true);
    expect(samePath("C:\\Vault\\Note.md", "c:/vault/note.md")).toBe(true);
  });

  it("matches descendants but not sibling prefixes", () => {
    expect(pathContains("/vault/imports", "/vault/imports/apple/a.md")).toBe(true);
    expect(pathContains("/vault/imports", "/vault/imports")).toBe(true);
    expect(pathContains("/vault/imports", "/vault/imports-old/a.md")).toBe(false);
  });
});
