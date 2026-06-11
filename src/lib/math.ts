import DOMPurify from "dompurify";
import {
  scheduleVisualBlocks,
  type VisualBlockHandle,
  type VisualSchedulerOptions,
} from "./visualScheduler";

type KatexModule = typeof import("katex");
let katexPromise: Promise<KatexModule> | null = null;
let katexCssLoaded = false;

export async function getKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    katexPromise = import("katex");
    // CSS 随 JS 一起懒加载，避免 256KB JS + 24KB CSS 常驻冷启动关键路径
    if (!katexCssLoaded) {
      katexCssLoaded = true;
      void import("katex/dist/katex.min.css");
    }
  }
  return katexPromise;
}

/** 懒加载 KaTeX 并渲染一个公式为 HTML（MathPreview 浮层用）。 */
export async function renderMathToHtml(
  formula: string,
  display: boolean,
): Promise<string> {
  const katex = await getKatex();
  try {
    return DOMPurify.sanitize(
      katex.renderToString(formula, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
        output: "html",
      }),
      { USE_PROFILES: { html: true, mathMl: true, svg: true } },
    );
  } catch (e) {
    return DOMPurify.sanitize(
      `<span style="color:#e5484d;font-family:var(--font-mono);font-size:11px">${(e as Error).message}</span>`,
    );
  }
}

async function renderMathBlock(node: HTMLElement) {
  if (node.dataset.rendered) return;
  const tex = node.textContent ?? "";
  node.dataset.mathSource = tex;
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
