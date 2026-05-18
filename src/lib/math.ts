import DOMPurify from "dompurify";
import {
  scheduleVisualBlocks,
  type VisualBlockHandle,
  type VisualSchedulerOptions,
} from "./visualScheduler";

type KatexModule = typeof import("katex");
let katexPromise: Promise<KatexModule> | null = null;

async function getKatex(): Promise<KatexModule> {
  if (!katexPromise) katexPromise = import("katex");
  return katexPromise;
}

async function renderMathBlock(node: HTMLElement) {
  if (node.dataset.rendered) return;
  const tex = node.textContent ?? "";
  const displayMode = node.classList.contains("math-display");
  const katex = await getKatex();
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "htmlAndMathml",
    });
    node.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
    });
    node.dataset.rendered = "1";
    node.classList.toggle("katex-block", displayMode);
  } catch (err) {
    node.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
    node.title = `公式渲染失败：${(err as Error).message}`;
    node.dataset.rendered = "1";
    node.classList.add("math-error");
  }
}

/** Eager: render every math placeholder synchronously (export / small docs / tests). */
export async function renderMathIn(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>(".math:not([data-rendered])");
  for (const node of Array.from(nodes)) {
    await renderMathBlock(node);
  }
}

/**
 * Lazy: viewport-first + idle-yield scheduling. Cuts main-thread freeze on
 * math-heavy docs from O(blocks × compile) up-front to "render-as-you-scroll".
 */
export function renderMathLazy(
  root: HTMLElement,
  options: VisualSchedulerOptions = {},
): VisualBlockHandle {
  return scheduleVisualBlocks<HTMLElement>(
    root,
    ".math:not([data-rendered])",
    renderMathBlock,
    options,
  );
}
