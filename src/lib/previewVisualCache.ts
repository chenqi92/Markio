type PreviewVisualKind = "chart" | "mermaid" | "graphviz" | "plantuml" | "math";

interface PreviewVisualSpec {
  kind: PreviewVisualKind;
  selector: string;
  sourceAttr?: string;
  extraAttrs?: string[];
  themeSensitive?: boolean;
}

const VISUAL_SPECS: PreviewVisualSpec[] = [
  { kind: "chart", selector: ".chart-block[data-chart]", sourceAttr: "data-chart" },
  {
    kind: "mermaid",
    selector: ".mermaid-block[data-mermaid]",
    sourceAttr: "data-mermaid",
    themeSensitive: true,
  },
  { kind: "graphviz", selector: ".graphviz-block[data-graphviz]", sourceAttr: "data-graphviz" },
  {
    kind: "plantuml",
    selector: ".plantuml-block[data-plantuml]",
    sourceAttr: "data-plantuml",
    extraAttrs: ["data-plantuml-server"],
  },
  { kind: "math", selector: ".math", sourceAttr: "data-math-source" },
];

const MAX_CACHE_SIZE = 160;
const MAX_RESTORE_HTML_LENGTH = 1_000_000;

function cacheKey(spec: PreviewVisualSpec, node: Element, themeId: string): string | null {
  const source = spec.sourceAttr
    ? (node.getAttribute(spec.sourceAttr) ?? node.textContent)
    : node.textContent;
  if (!source) return null;
  const parts = [
    // 渲染管线版本：升一位让旧缓存（如 mermaid 空框 SVG）失效，无需用户清缓存
    "v2",
    spec.kind,
    spec.themeSensitive ? themeId : "",
    source,
    ...(spec.extraAttrs ?? []).map((attr) => node.getAttribute(attr) ?? ""),
  ];
  return parts.join("\u0000");
}

function specForNode(node: Element): PreviewVisualSpec | null {
  return VISUAL_SPECS.find((spec) => node.matches(spec.selector)) ?? null;
}

function replaceFindMarks(root: ParentNode) {
  root.querySelectorAll("mark.find-hit").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  });
}

function unwrapTableHosts(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".md-table-add").forEach((button) => button.remove());
  root.querySelectorAll<HTMLElement>(".md-table-host").forEach((host) => {
    const table = host.querySelector("table");
    if (!table || !host.parentNode) return;
    host.parentNode.insertBefore(table, host);
    host.remove();
  });
}

function cleanCachedClone(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  replaceFindMarks(clone);
  unwrapTableHosts(clone);
  return clone;
}

function copySourceMetadata(from: Element, to: HTMLElement) {
  const line = from.getAttribute("data-line");
  if (line === null) {
    to.removeAttribute("data-line");
  } else {
    to.setAttribute("data-line", line);
  }
}

function remember(cache: Map<string, string>, key: string, html: string) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, html);
  while (cache.size > MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function snapshotPreviewVisualBlocks(
  root: HTMLElement | null,
  themeId: string,
): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!root) return snapshot;

  const selector = VISUAL_SPECS.map((spec) => `${spec.selector}[data-rendered]`).join(",");
  root.querySelectorAll<HTMLElement>(selector).forEach((node) => {
    const spec = specForNode(node);
    if (!spec) return;
    const key = cacheKey(spec, node, themeId);
    if (!key) return;
    snapshot.set(key, cleanCachedClone(node).outerHTML);
  });
  return snapshot;
}

export function mergePreviewVisualSnapshot(
  cache: Map<string, string>,
  root: HTMLElement | null,
  themeId: string,
) {
  for (const [key, html] of snapshotPreviewVisualBlocks(root, themeId)) {
    remember(cache, key, html);
  }
}

export function restorePreviewVisualBlocks(
  html: string,
  cache: Map<string, string>,
  themeId: string,
): string {
  if (cache.size === 0 || !html) return html;
  if (html.length > MAX_RESTORE_HTML_LENGTH) return html;

  const template = document.createElement("template");
  template.innerHTML = html;

  const selector = VISUAL_SPECS.map((spec) => `${spec.selector}:not([data-rendered])`).join(",");
  template.content.querySelectorAll<HTMLElement>(selector).forEach((node) => {
    const spec = specForNode(node);
    if (!spec) return;
    const key = cacheKey(spec, node, themeId);
    if (!key) return;
    const cached = cache.get(key);
    if (!cached) return;

    const cachedTemplate = document.createElement("template");
    cachedTemplate.innerHTML = cached;
    const cachedNode = cachedTemplate.content.firstElementChild as HTMLElement | null;
    if (!cachedNode || !cachedNode.matches(spec.selector)) return;
    copySourceMetadata(node, cachedNode);
    node.replaceWith(cachedNode);
  });

  return template.innerHTML;
}
