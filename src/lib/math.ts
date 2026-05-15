import DOMPurify from "dompurify";

/** Render pulldown-cmark math placeholders (`.math-inline` / `.math-display`) with KaTeX. */
export async function renderMathIn(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>(".math:not([data-rendered])");
  if (nodes.length === 0) return;

  const katex = await import("katex");
  for (const node of Array.from(nodes)) {
    const tex = node.textContent ?? "";
    const displayMode = node.classList.contains("math-display");
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
}
