/**
 * KaTeX 块级 / 行内公式 widget。
 *
 * KaTeX 整库 ~256KB，走 lazy import；首个公式才触发拉取。MathWidget 用
 * AbortController 在 destroy 时取消后续写 host —— 避免 widget 已失效但 lazy
 * chunk 才到时浪费 sanitize。
 */

import { WidgetType } from "@codemirror/view";
import DOMPurify from "dompurify";

type KatexModule = typeof import("katex");

let katexPromise: Promise<KatexModule> | null = null;
function getKatex(): Promise<KatexModule> {
  if (!katexPromise) katexPromise = import("katex");
  return katexPromise;
}

// 渲染失败时不让 widget 退化为空白 —— 显示带 ❗ 的灰字，让用户知道写错了。
// signal 来自 widget destroy：如果 widget 在 katex lazy chunk 拉完前就被销毁，
// 跳过后续写 host，避免写到游离 DOM（无副作用但清洁，且省 sanitize 调用）。
function renderKatexInto(
  host: HTMLElement,
  source: string,
  display: boolean,
  signal?: AbortSignal,
) {
  void getKatex()
    .then((katex) => {
      if (signal?.aborted) return;
      try {
        const html = katex.renderToString(source, {
          displayMode: display,
          throwOnError: false,
          strict: "ignore",
          output: "htmlAndMathml",
        });
        if (signal?.aborted) return;
        host.innerHTML = DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true, mathMl: true, svg: true },
        });
      } catch (err) {
        if (signal?.aborted) return;
        host.classList.add("cm-md-math-error");
        host.textContent = `❗ ${(err as Error).message}`;
      }
    })
    .catch((err) => {
      if (signal?.aborted) return;
      host.classList.add("cm-md-math-error");
      host.textContent = `❗ KaTeX 加载失败：${(err as Error).message}`;
    });
}

export class MathWidget extends WidgetType {
  private readonly abort = new AbortController();
  constructor(
    private readonly source: string,
    private readonly display: boolean,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof MathWidget &&
      other.source === this.source &&
      other.display === this.display
    );
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-md-math-block" : "cm-md-math-inline";
    el.dataset.mathDisplay = String(this.display);
    el.textContent = this.display ? `$$${this.source}$$` : `$${this.source}$`;
    renderKatexInto(el, this.source, this.display, this.abort.signal);
    return el;
  }
  ignoreEvent() {
    // Let mousedown bubble so the wysiwyg plugin can move the caret into the source.
    return false;
  }
  destroy() {
    this.abort.abort();
  }
}
