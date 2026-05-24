// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildPreviewAnchors,
  scrollPosForLine,
  scrollRatio,
  topLineFromScroll,
} from "./scrollSync";

const ANCHORS = [
  { line: 1, top: 0 },
  { line: 5, top: 200 },
  { line: 12, top: 600 },
  { line: 25, top: 1200 },
];

describe("topLineFromScroll", () => {
  it("clamps to first anchor below range", () => {
    expect(topLineFromScroll(ANCHORS, -50)).toBe(1);
    expect(topLineFromScroll(ANCHORS, 0)).toBe(1);
  });
  it("clamps to last anchor above range", () => {
    expect(topLineFromScroll(ANCHORS, 1200)).toBe(25);
    expect(topLineFromScroll(ANCHORS, 9999)).toBe(25);
  });
  it("interpolates linearly between anchors", () => {
    // halfway between (line 5, top 200) and (line 12, top 600) is top 400, line 8.5
    expect(topLineFromScroll(ANCHORS, 400)).toBeCloseTo(8.5, 5);
  });
  it("returns null on empty anchors", () => {
    expect(topLineFromScroll([], 100)).toBeNull();
  });
});

describe("scrollPosForLine", () => {
  it("clamps to first anchor for early lines", () => {
    expect(scrollPosForLine(ANCHORS, 0)).toBe(0);
    expect(scrollPosForLine(ANCHORS, 1)).toBe(0);
  });
  it("clamps to last anchor for late lines", () => {
    expect(scrollPosForLine(ANCHORS, 25)).toBe(1200);
    expect(scrollPosForLine(ANCHORS, 9999)).toBe(1200);
  });
  it("interpolates between anchors", () => {
    // line 8.5 should map back to scrollTop 400
    expect(scrollPosForLine(ANCHORS, 8.5)).toBeCloseTo(400, 5);
  });
  it("is the inverse of topLineFromScroll on the anchor grid", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1200, noNaN: true }), (scrollTop) => {
        const line = topLineFromScroll(ANCHORS, scrollTop);
        if (line == null) return;
        const back = scrollPosForLine(ANCHORS, line);
        if (back == null) return;
        expect(back).toBeCloseTo(scrollTop, 3);
      }),
      { numRuns: 200 },
    );
  });
});

describe("scrollRatio", () => {
  it("returns 0 when content fits in viewport", () => {
    expect(scrollRatio({ top: 0, height: 500, clientHeight: 500 })).toBe(0);
    expect(scrollRatio({ top: 0, height: 100, clientHeight: 500 })).toBe(0);
  });
  it("returns 1 at bottom", () => {
    expect(scrollRatio({ top: 500, height: 1000, clientHeight: 500 })).toBe(1);
  });
  it("clamps to [0,1]", () => {
    expect(scrollRatio({ top: -100, height: 1000, clientHeight: 500 })).toBe(0);
    expect(scrollRatio({ top: 9999, height: 1000, clientHeight: 500 })).toBe(1);
  });
});

describe("buildPreviewAnchors", () => {
  const rect = (top: number, height = 20): DOMRect =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  it("collects [data-line] elements, sorted by line", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollTop", { value: 0, configurable: true });
    root.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const make = (line: number, top: number) => {
      const el = document.createElement("p");
      el.setAttribute("data-line", String(line));
      el.getBoundingClientRect = () => rect(top);
      return el;
    };
    // Append out of order to test sort.
    root.append(make(5, 200), make(1, 0), make(12, 600));
    document.body.appendChild(root);

    const anchors = buildPreviewAnchors(root);
    expect(anchors).toEqual([
      { line: 1, top: 0 },
      { line: 5, top: 200 },
      { line: 12, top: 600 },
    ]);
  });

  it("adds row-level anchors for markdown tables", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollTop", { value: 0, configurable: true });
    root.getBoundingClientRect = () => rect(0, 0);
    root.innerHTML = `
      <table data-line="10">
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody>
          <tr><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
        </tbody>
      </table>
      <p data-line="20">next</p>
    `;
    const table = root.querySelector<HTMLElement>("table")!;
    const headRow = root.querySelector<HTMLElement>("thead tr")!;
    const bodyRows = root.querySelectorAll<HTMLElement>("tbody tr");
    const next = root.querySelector<HTMLElement>("p")!;
    table.getBoundingClientRect = () => rect(100, 120);
    headRow.getBoundingClientRect = () => rect(100, 30);
    bodyRows[0]!.getBoundingClientRect = () => rect(150, 30);
    bodyRows[1]!.getBoundingClientRect = () => rect(190, 30);
    next.getBoundingClientRect = () => rect(260);
    document.body.appendChild(root);

    expect(buildPreviewAnchors(root)).toEqual([
      { line: 10, top: 100 },
      { line: 12, top: 150 },
      { line: 13, top: 190 },
      { line: 20, top: 260 },
    ]);
  });

  it("adds a terminal anchor for the document end", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(root, "scrollHeight", { value: 900, configurable: true });
    root.getBoundingClientRect = () => rect(0, 0);
    const p = document.createElement("p");
    p.setAttribute("data-line", "1");
    p.getBoundingClientRect = () => rect(0);
    root.append(p);
    document.body.appendChild(root);

    expect(buildPreviewAnchors(root, 20)).toEqual([
      { line: 1, top: 0 },
      { line: 21, top: 900, kind: "terminal" },
    ]);
  });

  it("uses headings as primary sync anchors when available", () => {
    const anchors = [
      { line: 1, top: 0, kind: "heading" as const },
      { line: 5, top: 300 },
      { line: 10, top: 600, kind: "heading" as const },
      { line: 20, top: 1200, kind: "terminal" as const },
    ];

    expect(scrollPosForLine(anchors, 5.5)).toBeCloseTo(300, 5);
    expect(topLineFromScroll(anchors, 300)).toBeCloseTo(5.5, 5);
  });

  it("marks rendered markdown headings as heading anchors", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollTop", { value: 0, configurable: true });
    root.getBoundingClientRect = () => rect(0, 0);
    const h2 = document.createElement("h2");
    h2.setAttribute("data-line", "8");
    h2.getBoundingClientRect = () => rect(240);
    root.append(h2);
    document.body.appendChild(root);

    expect(buildPreviewAnchors(root)).toEqual([
      { line: 8, top: 240, kind: "heading" },
    ]);
  });

  it("skips invalid / non-monotonic anchors", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "scrollTop", { value: 0, configurable: true });
    root.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const make = (lineAttr: string, top: number) => {
      const el = document.createElement("p");
      el.setAttribute("data-line", lineAttr);
      el.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          left: 0,
          right: 0,
          width: 0,
          height: 20,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
      return el;
    };
    root.append(
      make("0", 0), // line <= 0 → drop
      make("not-a-number", 50), // NaN → drop
      make("5", 200),
      make("5", 250), // duplicate line → drop
      make("8", 150), // non-monotonic top → drop
      make("10", 400),
    );
    document.body.appendChild(root);

    expect(buildPreviewAnchors(root)).toEqual([
      { line: 5, top: 200 },
      { line: 10, top: 400 },
    ]);
  });

  it("returns [] for a container with no data-line", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>no anchors here</p>";
    document.body.appendChild(root);
    expect(buildPreviewAnchors(root)).toEqual([]);
  });
});
