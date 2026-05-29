import { useSettings } from "@/stores/settings";
import { isDarkTheme } from "@/themes";
import DOMPurify from "dompurify";
import {
  scheduleVisualBlocks,
  type VisualBlockHandle,
  type VisualSchedulerOptions,
} from "./visualScheduler";

type MermaidModule = typeof import("mermaid")["default"];

// 桌面应用长跑：mermaid 实例只 load 一次，主题切换时复用同一实例改配置。
// Vite 的 dynamic import 本身有缓存，但显式持有避免每次都走 micro-task。
let mermaidPromise: Promise<MermaidModule> | null = null;
let initializedTheme: string | null = null;
let counter = 0;

async function getMermaid(themeId: string): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidPromise;
  if (initializedTheme !== themeId) {
    const dark = isDarkTheme(themeId);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "var(--font-sans), system-ui, sans-serif",
      // 用原生 SVG <text> 渲染标签，而不是 <foreignObject> 里的 HTML——
      // 后者在 DOMPurify 清洗（svg profile）时会被剥成空框没文字。
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    initializedTheme = themeId;
  }
  return mermaid;
}

export async function renderMermaidBlock(block: HTMLElement) {
  if (block.dataset.rendered) return;
  const themeId = useSettings.getState().theme;
  const mermaid = await getMermaid(themeId);

  const encoded = block.getAttribute("data-mermaid") ?? "";
  const source = decodeURIComponent(encoded);
  const id = `mmd-${counter++}`;
  try {
    const { svg } = await mermaid.render(id, source);
    // mermaid 默认主题把节点标签放在 <foreignObject> 里的 HTML <div class="nodeLabel">，
    // 只开 svg profile 会被 DOMPurify 当非 SVG 内容剥掉 → 只剩空框没文字。
    // 同时开 html profile 保留标签（SVG 来自本地 mermaid 且已 securityLevel:strict）。
    block.innerHTML = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
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

/** Eager: render every `.mermaid-block` synchronously (export / small docs / tests). */
export async function renderMermaidIn(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-rendered])");
  for (const block of Array.from(blocks)) {
    await renderMermaidBlock(block);
  }
}

/**
 * Lazy: viewport-first scheduling. Mermaid SVG layout is heavy; doing all
 * blocks in `Promise.all` on a chart-heavy doc freezes the main thread.
 * Serial + yielding keeps the editor responsive.
 */
export function renderMermaidLazy(
  root: HTMLElement,
  options: VisualSchedulerOptions = {},
): VisualBlockHandle {
  return scheduleVisualBlocks<HTMLElement>(
    root,
    ".mermaid-block:not([data-rendered])",
    renderMermaidBlock,
    options,
  );
}
