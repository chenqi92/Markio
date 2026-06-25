// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { relativeHref, rewriteForSite, siteRelPath } from "./siteExport";

describe("siteRelPath", () => {
  it("strips workspace and swaps extension", () => {
    expect(siteRelPath("E:/vault/sub/Note.md", "E:/vault")).toBe("sub/Note.html");
  });
  it("handles backslashes and case-insensitive workspace prefix", () => {
    expect(siteRelPath("E:\\Vault\\a.md", "e:/vault")).toBe("a.html");
  });
});

describe("relativeHref", () => {
  it("same directory", () => {
    expect(relativeHref("a/p.html", "a/t.html")).toBe("t.html");
  });
  it("sibling directory", () => {
    expect(relativeHref("a/b/p.html", "a/c/t.html")).toBe("../c/t.html");
  });
  it("nested to root", () => {
    expect(relativeHref("a/b/p.html", "t.html")).toBe("../../t.html");
  });
  it("root to nested", () => {
    expect(relativeHref("p.html", "a/t.html")).toBe("a/t.html");
  });
});

describe("rewriteForSite", () => {
  it("rewrites wikilink with data-path to relative html", () => {
    const div = document.createElement("div");
    div.innerHTML =
      '<p><a class="wikilink" data-path="E:/vault/sub/Target.md">Target</a></p>';
    rewriteForSite(div, "Home.html", "E:/vault");
    const a = div.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("sub/Target.html");
    expect(a.classList.contains("wikilink")).toBe(false);
  });

  it("unlinks a missing wikilink to plain text", () => {
    const div = document.createElement("div");
    div.innerHTML = '<p><a class="wikilink missing">Ghost</a></p>';
    rewriteForSite(div, "Home.html", "E:/vault");
    expect(div.querySelector("a")).toBeNull();
    expect(div.textContent).toBe("Ghost");
  });

  it("rewrites relative .md links to .html keeping anchor", () => {
    const div = document.createElement("div");
    div.innerHTML = '<p><a href="notes/foo.md#sec">foo</a></p>';
    rewriteForSite(div, "Home.html", "E:/vault");
    expect(div.querySelector("a")!.getAttribute("href")).toBe("notes/foo.html#sec");
  });

  it("leaves external links untouched", () => {
    const div = document.createElement("div");
    div.innerHTML = '<p><a href="https://example.com/x.md">x</a></p>';
    rewriteForSite(div, "Home.html", "E:/vault");
    expect(div.querySelector("a")!.getAttribute("href")).toBe(
      "https://example.com/x.md",
    );
  });
});
