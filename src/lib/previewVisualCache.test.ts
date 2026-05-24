// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  mergePreviewVisualSnapshot,
  restorePreviewVisualBlocks,
  snapshotPreviewVisualBlocks,
} from "./previewVisualCache";

const chartSource = encodeURIComponent(`{
  "type": "bar",
  "title": "月度趋势",
  "labels": ["一月", "二月"],
  "series": [{ "name": "收入", "data": [12, 18] }]
}`);

describe("preview visual block cache", () => {
  it("restores an unchanged rendered chart while keeping the new source line", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="chart-block chart-rendered" data-chart="${chartSource}" data-rendered="1" data-line="36">
        <figure class="chart-card"><figcaption>月度趋势</figcaption></figure>
      </div>
    `;

    const cache = snapshotPreviewVisualBlocks(root, "light");
    const restored = restorePreviewVisualBlocks(
      `<div class="chart-block" data-chart="${chartSource}" data-line="40">{}</div>`,
      cache,
      "light",
    );

    const out = document.createElement("div");
    out.innerHTML = restored;
    const chart = out.querySelector<HTMLElement>(".chart-block")!;
    expect(chart.dataset.rendered).toBe("1");
    expect(chart.dataset.line).toBe("40");
    expect(chart.querySelector(".chart-card")).not.toBeNull();
    expect(chart.textContent).toContain("月度趋势");
  });

  it("does not restore when the visual block source changed", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="chart-block chart-rendered" data-chart="${chartSource}" data-rendered="1">
        <figure class="chart-card"></figure>
      </div>
    `;
    const cache = snapshotPreviewVisualBlocks(root, "light");
    const changedSource = encodeURIComponent(`{ "type": "bar", "data": [1, 2, 3] }`);

    const restored = restorePreviewVisualBlocks(
      `<div class="chart-block" data-chart="${changedSource}">{ "type": "bar" }</div>`,
      cache,
      "light",
    );

    const out = document.createElement("div");
    out.innerHTML = restored;
    const chart = out.querySelector<HTMLElement>(".chart-block")!;
    expect(chart.dataset.rendered).toBeUndefined();
    expect(chart.querySelector(".chart-card")).toBeNull();
  });

  it("skips restore on very large html payloads", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="chart-block chart-rendered" data-chart="${chartSource}" data-rendered="1">
        <figure class="chart-card"></figure>
      </div>
    `;
    const cache = snapshotPreviewVisualBlocks(root, "light");
    const largeHtml =
      `<div class="chart-block" data-chart="${chartSource}">{}</div>` +
      `<p>${"x".repeat(1_000_001)}</p>`;

    const restored = restorePreviewVisualBlocks(largeHtml, cache, "light");

    expect(restored).toBe(largeHtml);
  });

  it("keeps mermaid cache entries theme-specific", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="mermaid-block" data-mermaid="graph%20LR%0AA--%3EB" data-rendered="1">
        <svg data-theme="light"></svg>
      </div>
    `;
    const cache = snapshotPreviewVisualBlocks(root, "light");

    const restored = restorePreviewVisualBlocks(
      `<div class="mermaid-block" data-mermaid="graph%20LR%0AA--%3EB">graph LR</div>`,
      cache,
      "dark",
    );

    const out = document.createElement("div");
    out.innerHTML = restored;
    expect(out.querySelector(".mermaid-block")?.getAttribute("data-rendered")).toBeNull();
  });

  it("restores rendered math from the raw placeholder text", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <span class="math math-inline" data-math-source="x^2 + y^2" data-rendered="1">
        <span class="katex">rendered formula</span>
      </span>
    `;
    const cache = snapshotPreviewVisualBlocks(root, "light");

    const restored = restorePreviewVisualBlocks(
      `<span class="math math-inline">x^2 + y^2</span>`,
      cache,
      "light",
    );

    const out = document.createElement("div");
    out.innerHTML = restored;
    const math = out.querySelector<HTMLElement>(".math")!;
    expect(math.dataset.rendered).toBe("1");
    expect(math.dataset.mathSource).toBe("x^2 + y^2");
    expect(math.querySelector(".katex")).not.toBeNull();
  });

  it("strips transient find marks and table editing chrome from cached snapshots", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="chart-block chart-rendered" data-chart="${chartSource}" data-rendered="1">
        <figure class="chart-card">
          <figcaption><mark class="find-hit current">月度</mark>趋势</figcaption>
          <div class="md-table-host">
            <button class="md-table-add md-table-add-row">+ 行</button>
            <table><tbody><tr><td>12</td></tr></tbody></table>
          </div>
        </figure>
      </div>
    `;
    const cache = new Map<string, string>();
    mergePreviewVisualSnapshot(cache, root, "light");
    const cachedHtml = Array.from(cache.values())[0];

    expect(cachedHtml).toContain("月度趋势");
    expect(cachedHtml).toContain("<table>");
    expect(cachedHtml).not.toContain("find-hit");
    expect(cachedHtml).not.toContain("md-table-host");
    expect(cachedHtml).not.toContain("md-table-add");
  });
});
