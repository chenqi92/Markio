function parseLineSpec(spec: string | null): Set<number> {
  const lines = new Set<number>();
  if (!spec) return lines;
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let line = Math.min(start, end); line <= Math.max(start, end); line++) {
        lines.add(line);
      }
      continue;
    }
    const line = Number(trimmed);
    if (Number.isInteger(line) && line > 0) lines.add(line);
  }
  return lines;
}

function codeLines(raw: string): string[] {
  const withoutFinalNewline = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return withoutFinalNewline.split("\n");
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function addHighlightLayer(pre: HTMLPreElement, highlightedLines: Set<number>) {
  if (highlightedLines.size === 0) return;
  const layer = document.createElement("div");
  layer.className = "code-line-highlight-layer";
  for (const line of Array.from(highlightedLines).sort((a, b) => a - b)) {
    const marker = document.createElement("span");
    marker.className = "code-line-highlight";
    marker.style.transform = `translateY(${(line - 1) * 1.6}em)`;
    layer.append(marker);
  }
  pre.prepend(layer);
}

export function enhanceCodeBlocks(root: HTMLElement) {
  root.querySelectorAll<HTMLPreElement>("pre:not([data-code-enhanced])").forEach((pre) => {
    if (pre.closest(".mermaid-block, .code-block")) return;
    const code = pre.querySelector("code");
    if (!code) return;

    const raw = code.textContent ?? "";
    const lang = pre.dataset.lang?.trim() ?? "";
    const title = pre.dataset.title?.trim() ?? "";
    const highlightedLines = parseLineSpec(pre.dataset.highlightLines ?? null);
    const lines = codeLines(raw);

    const figure = document.createElement("figure");
    figure.className = "code-block";
    figure.dataset.lang = lang;

    const head = document.createElement("figcaption");
    head.className = "code-block-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "code-block-title";
    const titleText = document.createElement("span");
    titleText.className = "code-block-title-main";
    titleText.textContent = title || lang || "代码";
    titleWrap.append(titleText);
    if (title && lang) {
      const langEl = document.createElement("span");
      langEl.className = "code-block-lang";
      langEl.textContent = lang;
      titleWrap.append(langEl);
    }

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-block-copy";
    copy.setAttribute("aria-label", "复制代码");
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      await copyText(raw);
      copy.textContent = "已复制";
      window.setTimeout(() => {
        copy.textContent = "复制";
      }, 1200);
    });

    head.append(titleWrap, copy);

    const body = document.createElement("div");
    body.className = "code-block-body";
    const gutter = document.createElement("div");
    gutter.className = "code-line-gutter";
    lines.forEach((_, index) => {
      const lineNumber = index + 1;
      const item = document.createElement("span");
      item.textContent = String(lineNumber);
      if (highlightedLines.has(lineNumber)) item.dataset.active = "true";
      gutter.append(item);
    });

    pre.dataset.codeEnhanced = "1";
    addHighlightLayer(pre, highlightedLines);

    const parent = pre.parentNode;
    if (!parent) return;
    parent.insertBefore(figure, pre);
    body.append(gutter, pre);
    figure.append(head, body);
  });
}
