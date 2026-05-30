import { describe, expect, it } from "vitest";
import {
  pathContains,
  resolveRelativePath,
  samePath,
  slugifyHeading,
} from "./utils";

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

describe("resolveRelativePath", () => {
  const base = "/Users/me/vault/00-basics/links.md";

  it("resolves ../ against the note directory", () => {
    expect(resolveRelativePath(base, "../README.md")).toBe(
      "/Users/me/vault/README.md",
    );
  });

  it("resolves sibling files and strips #anchor / ?query", () => {
    expect(resolveRelativePath(base, "inline-formatting.md#行内代码")).toBe(
      "/Users/me/vault/00-basics/inline-formatting.md",
    );
    expect(resolveRelativePath(base, "./a.md?v=1")).toBe(
      "/Users/me/vault/00-basics/a.md",
    );
  });

  it("decodes percent-encoded paths", () => {
    expect(resolveRelativePath(base, "../path%20with%20space.md")).toBe(
      "/Users/me/vault/path with space.md",
    );
  });

  it("keeps absolute targets and handles Windows drives", () => {
    expect(resolveRelativePath(base, "/abs/x.md")).toBe("/abs/x.md");
    expect(
      resolveRelativePath("C:/vault/sub/note.md", "../img/a.png"),
    ).toBe("C:/vault/img/a.png");
  });

  it("returns null for empty or pure-anchor hrefs", () => {
    expect(resolveRelativePath(base, "#sec")).toBeNull();
    expect(resolveRelativePath(base, "")).toBeNull();
  });
});

describe("slugifyHeading", () => {
  it("lowercases, collapses separators, keeps CJK", () => {
    expect(slugifyHeading("Heading One")).toBe("heading-one");
    expect(slugifyHeading("带特殊字符的链接")).toBe("带特殊字符的链接");
    expect(slugifyHeading("  trailing -- dashes  ")).toBe("trailing-dashes");
    expect(slugifyHeading("!!!")).toBe("section");
  });
});
