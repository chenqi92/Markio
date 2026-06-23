// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { blockExternalImages, _internal } from "./remoteImageGuard";

function makeRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("blockExternalImages", () => {
  it("replaces http(s) src with placeholder and preserves original", () => {
    const root = makeRoot(`
      <img src="https://example.com/a.png" />
      <img src="http://example.org/b.jpg" />
      <img src="data:image/png;base64,xxx" />
      <img src="local/image.png" />
    `);

    const cleanup = blockExternalImages(root);

    const imgs = root.querySelectorAll("img");
    expect(imgs[0]!.getAttribute("data-original-src")).toBe(
      "https://example.com/a.png",
    );
    expect(imgs[0]!.classList.contains(_internal.BLOCK_CLASS)).toBe(true);
    expect(imgs[0]!.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);

    expect(imgs[1]!.getAttribute("data-original-src")).toBe(
      "http://example.org/b.jpg",
    );

    // data:/ 相对路径不动
    expect(imgs[2]!.getAttribute("src")).toBe("data:image/png;base64,xxx");
    expect(imgs[2]!.classList.contains(_internal.BLOCK_CLASS)).toBe(false);

    expect(imgs[3]!.getAttribute("src")).toBe("local/image.png");
    expect(imgs[3]!.classList.contains(_internal.BLOCK_CLASS)).toBe(false);

    cleanup();
    root.remove();
  });

  it("blocks protocol-relative URLs (//host/pixel.png)", () => {
    const root = makeRoot(`
      <img src="//tracker.example.com/pixel.png" />
      <img src="/local/abs.png" />
    `);
    const cleanup = blockExternalImages(root);

    const imgs = root.querySelectorAll("img");
    // 协议相对：拦截
    expect(imgs[0]!.getAttribute("data-original-src")).toBe(
      "//tracker.example.com/pixel.png",
    );
    expect(imgs[0]!.classList.contains(_internal.BLOCK_CLASS)).toBe(true);
    // 单斜杠绝对路径（本地资源）：不动
    expect(imgs[1]!.getAttribute("src")).toBe("/local/abs.png");
    expect(imgs[1]!.classList.contains(_internal.BLOCK_CLASS)).toBe(false);

    cleanup();
    root.remove();
  });

  it("restores src on click", () => {
    const root = makeRoot(`<img src="https://example.com/a.png" />`);
    const cleanup = blockExternalImages(root);

    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);

    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(img.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img.classList.contains(_internal.BLOCK_CLASS)).toBe(false);
    expect(img.hasAttribute("data-original-src")).toBe(false);

    cleanup();
    root.remove();
  });

  it("restores src on Enter keypress (a11y)", () => {
    const root = makeRoot(`<img src="https://example.com/a.png" />`);
    const cleanup = blockExternalImages(root);

    const img = root.querySelector("img")!;
    img.focus();
    img.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(img.getAttribute("src")).toBe("https://example.com/a.png");

    cleanup();
    root.remove();
  });

  it("cleanup removes listeners (no restore after cleanup)", () => {
    const root = makeRoot(`<img src="https://example.com/a.png" />`);
    const cleanup = blockExternalImages(root);
    cleanup();

    const img = root.querySelector("img")!;
    const beforeSrc = img.getAttribute("src");
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // 仍为占位，没被恢复
    expect(img.getAttribute("src")).toBe(beforeSrc);
    expect(img.getAttribute("data-original-src")).toBe("https://example.com/a.png");

    root.remove();
  });
});
