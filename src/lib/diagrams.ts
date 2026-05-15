import DOMPurify from "dompurify";
import { deflateRaw } from "pako";

type VizInstance = {
  renderSVGElement: (source: string, options?: { engine?: string }) => SVGSVGElement;
};

let vizPromise: Promise<VizInstance> | null = null;

const PLANTUML_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function decodeSource(encoded: string) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function getViz() {
  if (!vizPromise) {
    vizPromise = import("@viz-js/viz").then((mod) => mod.instance() as Promise<VizInstance>);
  }
  return vizPromise;
}

function appendEncodedTriplet(out: string[], b1: number, b2: number, b3: number) {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  out.push(
    PLANTUML_ALPHABET[c1],
    PLANTUML_ALPHABET[c2],
    PLANTUML_ALPHABET[c3],
    PLANTUML_ALPHABET[c4],
  );
}

export function plantUmlEncode(source: string) {
  const compressed = deflateRaw(new TextEncoder().encode(source), { level: 9 });
  const out: string[] = [];
  for (let i = 0; i < compressed.length; i += 3) {
    appendEncodedTriplet(
      out,
      compressed[i],
      compressed[i + 1] ?? 0,
      compressed[i + 2] ?? 0,
    );
  }
  return out.join("");
}

export function normalizePlantUmlServer(input: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("PlantUML server 为空");
  const url = new URL(trimmed);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PlantUML server 只支持 http/https");
  }
  return url.toString().replace(/\/+$/, "");
}

function plantUmlUrl(server: string, source: string) {
  return `${normalizePlantUmlServer(server)}/svg/${plantUmlEncode(source)}`;
}

function sourceDetails(label: string, source: string) {
  const details = create("details", "diagram-source");
  const summary = create("summary", undefined, label);
  const pre = create("pre");
  pre.textContent = source;
  details.append(summary, pre);
  return details;
}

function diagramShell(kind: string, subtitle?: string) {
  const figure = create("figure", "diagram-card");
  const head = create("figcaption", "diagram-head");
  head.append(create("div", "diagram-title", kind));
  if (subtitle) head.append(create("div", "diagram-subtitle", subtitle));
  const viewport = create("div", "diagram-viewport");
  figure.append(head, viewport);
  return { figure, viewport };
}

function renderError(block: HTMLElement, kind: string, message: string, source: string) {
  const { figure, viewport } = diagramShell(kind, "渲染失败");
  const pre = create("pre", "diagram-error");
  pre.textContent = `${message}\n\n${source}`;
  viewport.append(pre);
  figure.append(sourceDetails("源代码", source));
  block.replaceChildren(figure);
  block.dataset.rendered = "1";
  block.classList.add("diagram-rendered", "diagram-failed");
}

async function renderGraphvizBlock(block: HTMLElement) {
  const source = decodeSource(block.getAttribute("data-graphviz") ?? block.textContent ?? "");
  try {
    const viz = await getViz();
    const svg = viz.renderSVGElement(source, { engine: "dot" });
    const serialized = new XMLSerializer().serializeToString(svg);
    const { figure, viewport } = diagramShell("Graphviz / DOT", "本地离线渲染");
    viewport.innerHTML = DOMPurify.sanitize(serialized, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
    figure.append(sourceDetails("DOT 源代码", source));
    block.replaceChildren(figure);
    block.dataset.rendered = "1";
    block.classList.add("diagram-rendered");
  } catch (err) {
    renderError(block, "Graphviz / DOT", (err as Error).message, source);
  }
}

function renderPlantUmlPlaceholder(block: HTMLElement, source: string) {
  const { figure, viewport } = diagramShell("PlantUML", "需要显式配置渲染服务");
  const message = create(
    "div",
    "diagram-notice",
    "已识别 PlantUML 块。为保护笔记内容，Markio 不会默认把源码发送到公网服务器；如需渲染，可在代码围栏写 server=\"https://你的-plantuml-server\"。",
  );
  viewport.append(message);
  figure.append(sourceDetails("PlantUML 源代码", source));
  block.replaceChildren(figure);
  block.dataset.rendered = "1";
  block.classList.add("diagram-rendered");
}

function renderPlantUmlBlock(block: HTMLElement) {
  const source = decodeSource(block.getAttribute("data-plantuml") ?? block.textContent ?? "");
  const server = block.getAttribute("data-plantuml-server") ?? "";
  if (!server.trim()) {
    renderPlantUmlPlaceholder(block, source);
    return;
  }
  try {
    const { figure, viewport } = diagramShell("PlantUML", normalizePlantUmlServer(server));
    const img = create("img", "diagram-img") as HTMLImageElement;
    img.alt = "PlantUML diagram";
    img.loading = "lazy";
    img.src = plantUmlUrl(server, source);
    img.addEventListener("error", () => {
      renderError(block, "PlantUML", "PlantUML 服务未返回可用图片", source);
    });
    viewport.append(img);
    figure.append(sourceDetails("PlantUML 源代码", source));
    block.replaceChildren(figure);
    block.dataset.rendered = "1";
    block.classList.add("diagram-rendered");
  } catch (err) {
    renderError(block, "PlantUML", (err as Error).message, source);
  }
}

export async function renderDiagramsIn(root: HTMLElement) {
  const graphvizBlocks = Array.from(
    root.querySelectorAll<HTMLElement>(".graphviz-block:not([data-rendered])"),
  );
  const plantUmlBlocks = Array.from(
    root.querySelectorAll<HTMLElement>(".plantuml-block:not([data-rendered])"),
  );

  await Promise.all(graphvizBlocks.map((block) => renderGraphvizBlock(block)));
  plantUmlBlocks.forEach(renderPlantUmlBlock);
}
