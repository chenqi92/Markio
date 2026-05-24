import {
  scheduleVisualBlocks,
  type VisualBlockHandle,
  type VisualSchedulerOptions,
} from "./visualScheduler";

export type ChartKind = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ChartConfig {
  type: ChartKind;
  title: string;
  subtitle?: string;
  labels: string[];
  series: ChartSeries[];
  unit?: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_SERIES = 8;
const MAX_POINTS = 80;
const VIEWBOX = { width: 720, height: 360 };
const PLOT = { left: 58, top: 26, right: 22, bottom: 54 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseJsonLikeList(value: string): unknown[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringValue(item))
      .filter((item): item is string => !!item);
  }
  if (typeof value === "string") {
    const jsonList = parseJsonLikeList(value);
    if (jsonList) return stringArray(jsonList);
    return value
      .split(/[,，;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function numberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => numberValue(item))
      .filter((item): item is number => item !== null);
  }
  if (typeof value === "string") {
    const jsonList = parseJsonLikeList(value);
    if (jsonList) return numberArray(jsonList);
    return value
      .split(/[\s,，;；]+/)
      .map((item) => numberValue(item))
      .filter((item): item is number => item !== null);
  }
  return [];
}

function parseSeries(value: unknown): ChartSeries[] {
  if (Array.isArray(value)) {
    if (value.every((item) => numberValue(item) !== null)) {
      return [{ name: "值", data: numberArray(value) }];
    }
    return value.flatMap((item, index) => {
      if (!isRecord(item)) return [];
      const data = numberArray(item.data ?? item.values ?? item.y);
      if (data.length === 0) return [];
      return [
        {
          name: stringValue(item.name ?? item.label ?? item.title) ?? `系列 ${index + 1}`,
          data,
        },
      ];
    });
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([name, data]) => {
      const values = numberArray(data);
      return values.length > 0 ? [{ name, data: values }] : [];
    });
  }
  return [];
}

function parseLooseChart(source: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const series: Record<string, number[]> = {};
  let inSeries = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    if (/^series$/i.test(key) && !value) {
      inSeries = true;
      continue;
    }
    if (inSeries && indent > 0) {
      series[key] = numberArray(value);
      continue;
    }
    inSeries = false;
    if (/^(labels|categories|x)$/i.test(key)) {
      out.labels = stringArray(value);
    } else if (/^(values|data)$/i.test(key)) {
      out.values = numberArray(value);
    } else {
      out[key.toLowerCase()] = value;
    }
  }
  if (Object.keys(series).length > 0) out.series = series;
  return out;
}

function parseChartType(value: unknown): ChartKind {
  const type = stringValue(value)?.toLowerCase() ?? "bar";
  if (type === "bar" || type === "line" || type === "pie") return type;
  throw new Error(`不支持的图表类型：${type}`);
}

function normalizeChart(raw: Record<string, unknown>): ChartConfig {
  const type = parseChartType(raw.type);
  const title = stringValue(raw.title) ?? "图表";
  const subtitle = stringValue(raw.subtitle ?? raw.description);
  const unit = stringValue(raw.unit);
  let labels = stringArray(raw.labels ?? raw.categories ?? raw.x);
  let series = parseSeries(raw.series ?? raw.datasets ?? raw.dataset);

  if (series.length === 0) {
    const data = raw.values ?? raw.data;
    if (isRecord(data)) {
      const entries = Object.entries(data)
        .map(([label, value]) => ({ label, value: numberValue(value) }))
        .filter((item): item is { label: string; value: number } => item.value !== null);
      if (entries.length > 0) {
        if (labels.length === 0) labels = entries.map((item) => item.label);
        series = [
          {
            name: stringValue(raw.name) ?? "值",
            data: entries.map((item) => item.value),
          },
        ];
      }
    } else {
      const values = numberArray(data);
      if (values.length > 0) {
        series = [{ name: stringValue(raw.name) ?? "值", data: values }];
      }
    }
  }

  series = series.filter((item) => item.data.length > 0);
  if (series.length === 0) throw new Error("图表缺少可用数据");

  const maxLength = Math.max(...series.map((item) => item.data.length));
  if (labels.length === 0) {
    labels = Array.from({ length: maxLength }, (_, index) => `${index + 1}`);
  }
  while (labels.length < maxLength) labels.push(`${labels.length + 1}`);

  const pointCount = Math.min(labels.length, MAX_POINTS);
  labels = labels.slice(0, pointCount);
  series = series.slice(0, MAX_SERIES).map((item) => ({
    name: item.name,
    data: item.data.slice(0, pointCount),
  }));

  if (type === "pie") {
    const values = series[0]!.data
      .slice(0, labels.length)
      .map((value) => Math.max(0, value));
    const pairs = labels
      .map((label, index) => ({ label, value: values[index] ?? 0 }))
      .filter((item) => item.value > 0);
    if (pairs.length === 0) throw new Error("饼图至少需要一个大于 0 的数值");
    return {
      type,
      title,
      subtitle,
      unit,
      labels: pairs.map((item) => item.label),
      series: [{ name: series[0]!.name, data: pairs.map((item) => item.value) }],
    };
  }

  return { type, title, subtitle, unit, labels, series };
}

export function parseChartSource(source: string): ChartConfig {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("图表内容为空");
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) throw new Error("图表配置必须是对象");
    return normalizeChart(parsed);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return normalizeChart(parseLooseChart(trimmed));
    }
    throw err;
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

function svgNode(name: string, attrs: Record<string, string | number> = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function color(index: number) {
  return `var(--chart-${(index % 8) + 1})`;
}

function formatNumber(value: number, unit = "") {
  const abs = Math.abs(value);
  const compact =
    abs >= 1_000_000
      ? `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
      : abs >= 1_000
        ? `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
        : Number.isInteger(value)
          ? String(value)
          : value.toFixed(1);
  return `${compact}${unit}`;
}

function niceStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const fraction = value / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * base;
}

function niceBounds(values: number[]) {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = niceStep((max - min) / 4);
  return {
    min: Math.floor(min / step) * step,
    max: Math.ceil(max / step) * step,
    step,
  };
}

function xFor(index: number, count: number) {
  const width = VIEWBOX.width - PLOT.left - PLOT.right;
  if (count <= 1) return PLOT.left + width / 2;
  return PLOT.left + (width / (count - 1)) * index;
}

function cartesianSvg(config: ChartConfig, mode: "bar" | "line") {
  const svg = svgNode("svg", {
    class: "chart-svg",
    viewBox: `0 0 ${VIEWBOX.width} ${VIEWBOX.height}`,
    role: "img",
    "aria-label": config.title,
  });
  const values = config.series.flatMap((item) => item.data);
  const bounds = niceBounds(values);
  const plotWidth = VIEWBOX.width - PLOT.left - PLOT.right;
  const plotHeight = VIEWBOX.height - PLOT.top - PLOT.bottom;
  const y = (value: number) =>
    PLOT.top + ((bounds.max - value) / (bounds.max - bounds.min || 1)) * plotHeight;

  for (let tick = bounds.min; tick <= bounds.max + bounds.step / 2; tick += bounds.step) {
    const yy = y(tick);
    svg.append(
      svgNode("line", {
        class: "chart-grid",
        x1: PLOT.left,
        x2: VIEWBOX.width - PLOT.right,
        y1: yy,
        y2: yy,
      }),
    );
    const label = svgNode("text", {
      class: "chart-axis-label",
      x: PLOT.left - 10,
      y: yy + 4,
      "text-anchor": "end",
    });
    label.textContent = formatNumber(tick, config.unit);
    svg.append(label);
  }

  const axisY = y(Math.max(bounds.min, Math.min(0, bounds.max)));
  svg.append(
    svgNode("line", {
      class: "chart-axis",
      x1: PLOT.left,
      x2: VIEWBOX.width - PLOT.right,
      y1: axisY,
      y2: axisY,
    }),
  );

  const skip = Math.max(1, Math.ceil(config.labels.length / 9));
  config.labels.forEach((label, index) => {
    if (index % skip !== 0 && index !== config.labels.length - 1) return;
    const text = svgNode("text", {
      class: "chart-axis-label",
      x: xFor(index, config.labels.length),
      y: VIEWBOX.height - 16,
      "text-anchor": "middle",
    });
    text.textContent = label;
    svg.append(text);
  });

  if (mode === "bar") {
    const band = plotWidth / Math.max(1, config.labels.length);
    const groupGap = Math.min(18, Math.max(6, band * 0.18));
    const groupWidth = Math.max(4, band - groupGap);
    const lane = groupWidth / config.series.length;
    const barWidth = Math.max(3, lane - Math.min(6, lane * 0.22));
    const zeroY = y(0);
    config.series.forEach((series, seriesIndex) => {
      series.data.forEach((value, index) => {
        const xx =
          PLOT.left +
          index * band +
          groupGap / 2 +
          seriesIndex * lane +
          (lane - barWidth) / 2;
        const yy = value >= 0 ? y(value) : zeroY;
        const height = Math.max(1, Math.abs(y(value) - zeroY));
        svg.append(
          svgNode("rect", {
            class: "chart-bar",
            x: xx,
            y: yy,
            width: barWidth,
            height,
            rx: 2,
            fill: color(seriesIndex),
          }),
        );
      });
    });
  } else {
    config.series.forEach((series, seriesIndex) => {
      const points = series.data.map((value, index) => [
        xFor(index, config.labels.length),
        y(value),
      ]);
      const path = svgNode("path", {
        class: "chart-line",
        d: points
          .map(([xx, yy], index) => `${index === 0 ? "M" : "L"} ${xx!.toFixed(2)} ${yy!.toFixed(2)}`)
          .join(" "),
        stroke: color(seriesIndex),
      });
      svg.append(path);
      if (points.length <= 40) {
        points.forEach(([xx, yy]) => {
          svg.append(
            svgNode("circle", {
              class: "chart-point",
              cx: xx!,
              cy: yy!,
              r: 3,
              fill: color(seriesIndex),
            }),
          );
        });
      }
    });
  }

  return svg;
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function piePath(cx: number, cy: number, radius: number, start: number, end: number) {
  const a = polar(cx, cy, radius, start);
  const b = polar(cx, cy, radius, end);
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)} Z`;
}

function pieSvg(config: ChartConfig) {
  const svg = svgNode("svg", {
    class: "chart-svg chart-svg-pie",
    viewBox: `0 0 ${VIEWBOX.width} ${VIEWBOX.height}`,
    role: "img",
    "aria-label": config.title,
  });
  const values = config.series[0]!.data;
  const total = values.reduce((sum, value) => sum + value, 0);
  const cx = 250;
  const cy = 178;
  const radius = 116;
  let angle = -Math.PI / 2;

  values.forEach((value, index) => {
    const next = angle + (value / total) * Math.PI * 2;
    if (values.length === 1) {
      svg.append(
        svgNode("circle", {
          class: "chart-pie-slice",
          cx,
          cy,
          r: radius,
          fill: color(index),
        }),
      );
    } else {
      svg.append(
        svgNode("path", {
          class: "chart-pie-slice",
          d: piePath(cx, cy, radius, angle, next),
          fill: color(index),
        }),
      );
    }
    angle = next;
  });

  const totalText = svgNode("text", {
    class: "chart-pie-total",
    x: cx,
    y: cy - 4,
    "text-anchor": "middle",
  });
  totalText.textContent = formatNumber(total, config.unit);
  svg.append(totalText);
  const label = svgNode("text", {
    class: "chart-pie-label",
    x: cx,
    y: cy + 20,
    "text-anchor": "middle",
  });
  label.textContent = "合计";
  svg.append(label);
  return svg;
}

function legend(config: ChartConfig) {
  const wrap = create("div", "chart-legend");
  const total =
    config.type === "pie"
      ? config.series[0]!.data.reduce((sum, value) => sum + value, 0)
      : 0;
  const names =
    config.type === "pie"
      ? config.labels.map((label, index) => {
          const value = config.series[0]!.data[index] ?? 0;
          const percent = total > 0 ? ` · ${Math.round((value / total) * 100)}%` : "";
          return `${label} ${formatNumber(value, config.unit)}${percent}`;
        })
      : config.series.map((item) => item.name);
  names.forEach((name, index) => {
    const item = create("span", "chart-legend-item");
    const swatch = create("span", "chart-legend-swatch");
    swatch.style.background = color(index);
    item.append(swatch, document.createTextNode(name));
    wrap.append(item);
  });
  return wrap;
}

function dataTable(config: ChartConfig) {
  const details = create("details", "chart-data");
  const summary = create("summary", undefined, "数据表");
  const table = create("table");
  const thead = create("thead");
  const headRow = create("tr");
  if (config.type === "pie") {
    for (const text of ["项目", "值"]) {
      const th = create("th", undefined, text);
      th.setAttribute("scope", "col");
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = create("tbody");
    config.labels.forEach((label, index) => {
      const row = create("tr");
      row.append(create("td", undefined, label));
      row.append(create("td", undefined, formatNumber(config.series[0]!.data[index] ?? 0, config.unit)));
      tbody.append(row);
    });
    table.append(thead, tbody);
  } else {
    const first = create("th", undefined, "分类");
    first.setAttribute("scope", "col");
    headRow.append(first);
    config.series.forEach((series) => {
      const th = create("th", undefined, series.name);
      th.setAttribute("scope", "col");
      headRow.append(th);
    });
    thead.append(headRow);
    const tbody = create("tbody");
    config.labels.forEach((label, index) => {
      const row = create("tr");
      row.append(create("td", undefined, label));
      config.series.forEach((series) => {
        row.append(create("td", undefined, formatNumber(series.data[index] ?? 0, config.unit)));
      });
      tbody.append(row);
    });
    table.append(thead, tbody);
  }
  details.append(summary, table);
  return details;
}

function chartFigure(config: ChartConfig) {
  const figure = create("figure", "chart-card");
  const head = create("figcaption", "chart-head");
  head.append(create("div", "chart-title", config.title));
  if (config.subtitle) head.append(create("div", "chart-subtitle", config.subtitle));
  const viewport = create("div", "chart-viewport");
  viewport.append(config.type === "pie" ? pieSvg(config) : cartesianSvg(config, config.type));
  figure.append(head, legend(config), viewport, dataTable(config));
  return figure;
}

function decodeSource(encoded: string) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function renderError(block: HTMLElement, message: string, source: string) {
  const pre = create("pre", "chart-error");
  pre.textContent = `chart 渲染失败：${message}\n\n${source}`;
  block.replaceChildren(pre);
  block.dataset.rendered = "1";
  block.classList.add("chart-rendered", "chart-failed");
}

export function renderChartBlock(block: HTMLElement) {
  if (block.dataset.rendered) return;
  const source = decodeSource(block.getAttribute("data-chart") ?? block.textContent ?? "");
  try {
    const config = parseChartSource(source);
    block.replaceChildren(chartFigure(config));
    block.dataset.rendered = "1";
    block.classList.add("chart-rendered");
  } catch (err) {
    renderError(block, (err as Error).message, source);
  }
}

export function renderChartsIn(root: HTMLElement) {
  root
    .querySelectorAll<HTMLElement>(".chart-block:not([data-rendered])")
    .forEach(renderChartBlock);
}

export function renderChartsLazy(
  root: HTMLElement,
  options: VisualSchedulerOptions = {},
): VisualBlockHandle {
  return scheduleVisualBlocks<HTMLElement>(
    root,
    ".chart-block:not([data-rendered])",
    renderChartBlock,
    options,
  );
}
