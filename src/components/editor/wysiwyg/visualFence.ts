/**
 * Mermaid / Graphviz (dot) / Chart 可视化围栏 widget。
 *
 * 不在编辑器里重新实现这些渲染，而是直接复用 preview 那侧的 renderXxxBlock：
 * - 给 host 加 .mermaid-block / .graphviz-block / .chart-block class
 * - 写 data-mermaid / data-graphviz / data-chart 属性（URL encoded 源）
 * - 调对应 render 函数填充 DOM
 *
 * WidgetType 实例持 AbortController，destroy 时 abort —— 避免 widget 已失效
 * 但 mermaid lazy chunk / WASM 拉完后才写 host 的浪费。底层 render 库本身
 * 不支持 cancel，CPU 仍跑完。
 */

import { WidgetType } from "@codemirror/view";

import { renderChartBlock } from "@/lib/charts";
import { renderGraphvizBlock } from "@/lib/diagrams";
import { renderMermaidBlock } from "@/lib/mermaid";

export type VisualLang = "mermaid" | "dot" | "chart";

// Rendering visual fenced blocks inside the editor runs on CodeMirror's startup
// decoration path. Keep the WYSIWYG editor lightweight; split/preview mode owns
// the expensive chart/diagram rendering pipeline.
export const WYSIWYG_VISUAL_FENCES_ENABLED = true;

export function detectVisualLang(lang: string): VisualLang | null {
  const lower = lang.toLowerCase();
  if (lower === "mermaid") return "mermaid";
  if (lower === "dot" || lower === "graphviz") return "dot";
  if (lower === "chart" || lower === "markio-chart" || lower === "charts") return "chart";
  return null;
}

async function renderVisualWidget(
  host: HTMLElement,
  kind: VisualLang,
  source: string,
  signal?: AbortSignal,
) {
  const encoded = encodeURIComponent(source);
  try {
    if (kind === "mermaid") {
      host.classList.add("mermaid-block");
      host.setAttribute("data-mermaid", encoded);
      await renderMermaidBlock(host);
    } else if (kind === "dot") {
      host.classList.add("graphviz-block");
      host.setAttribute("data-graphviz", encoded);
      await renderGraphvizBlock(host, signal);
    } else {
      host.classList.add("chart-block");
      host.setAttribute("data-chart", encoded);
      renderChartBlock(host);
    }
  } catch (err) {
    if (signal?.aborted) return;
    host.classList.add("cm-md-fenced-error");
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "12px";
    pre.style.color = "var(--text-3)";
    pre.textContent = `${kind} 渲染失败：${(err as Error).message}\n\n${source}`;
    host.replaceChildren(pre);
  }
}

export class VisualFenceWidget extends WidgetType {
  private readonly abort = new AbortController();
  constructor(
    private readonly kind: VisualLang,
    private readonly source: string,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof VisualFenceWidget &&
      other.kind === this.kind &&
      other.source === this.source
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-md-fenced-widget cm-md-fenced-${this.kind}`;
    el.dataset.kind = this.kind;
    void renderVisualWidget(el, this.kind, this.source, this.abort.signal);
    return el;
  }
  ignoreEvent() {
    return false;
  }
  destroy() {
    this.abort.abort();
  }
}
