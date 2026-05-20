// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { inspectPreviewClick } from "./preview-context-menu";

describe("inspectPreviewClick", () => {
  it("detects an anchor with href", () => {
    const a = document.createElement("a");
    a.href = "https://example.com/page";
    a.textContent = "label";
    document.body.appendChild(a);
    const info = inspectPreviewClick(a);
    expect(info.link?.href).toBe("https://example.com/page");
    expect(info.link?.text).toBe("label");
    expect(info.link?.isWiki).toBe(false);
  });

  it("treats wiki link via data-path", () => {
    const a = document.createElement("a");
    a.className = "wikilink";
    a.setAttribute("data-path", "/notes/Foo.md");
    a.textContent = "Foo";
    document.body.appendChild(a);
    const info = inspectPreviewClick(a);
    expect(info.link?.isWiki).toBe(true);
    expect(info.link?.href).toBe("/notes/Foo.md");
  });

  it("detects an image", () => {
    const img = document.createElement("img");
    img.src = "https://x/y.png";
    img.alt = "pic";
    document.body.appendChild(img);
    const info = inspectPreviewClick(img);
    expect(info.image?.src).toBe("https://x/y.png");
    expect(info.image?.alt).toBe("pic");
  });

  it("detects code block + language class", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-ts";
    code.textContent = "const a = 1;";
    pre.appendChild(code);
    document.body.appendChild(pre);
    const info = inspectPreviewClick(code);
    expect(info.codeBlock?.lang).toBe("ts");
    expect(info.codeBlock?.text).toBe("const a = 1;");
  });

  it("returns all nulls on plain text", () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.appendChild(p);
    const info = inspectPreviewClick(p);
    expect(info.link).toBeNull();
    expect(info.image).toBeNull();
    expect(info.codeBlock).toBeNull();
  });
});
