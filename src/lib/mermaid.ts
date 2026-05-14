import { useSettings } from "@/stores/settings";
import { isDarkTheme } from "@/themes";
import DOMPurify from "dompurify";

let initialized = false;
let lastTheme: string | null = null;
let counter = 0;

async function init(themeId: string) {
  const mermaid = (await import("mermaid")).default;
  const dark = isDarkTheme(themeId);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    fontFamily: "var(--font-sans), system-ui, sans-serif",
  });
  initialized = true;
  lastTheme = themeId;
  return mermaid;
}

/** 把容器内所有 `.mermaid-block` 渲染成 SVG。重复调用安全。 */
export async function renderMermaidIn(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-rendered])");
  if (blocks.length === 0) return;

  const themeId = useSettings.getState().theme;
  let mermaid;
  if (!initialized || lastTheme !== themeId) {
    mermaid = await init(themeId);
  } else {
    mermaid = (await import("mermaid")).default;
  }

  for (const block of Array.from(blocks)) {
    const encoded = block.getAttribute("data-mermaid") ?? "";
    const source = decodeURIComponent(encoded);
    const id = `mmd-${counter++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      });
      block.dataset.rendered = "1";
    } catch (err) {
      const pre = document.createElement("pre");
      pre.style.color = "var(--text-3)";
      pre.style.fontSize = "12px";
      pre.style.whiteSpace = "pre-wrap";
      pre.textContent = `mermaid 渲染失败：${(err as Error).message}\n\n${source}`;
      block.replaceChildren(pre);
      block.dataset.rendered = "1";
    }
  }
}
