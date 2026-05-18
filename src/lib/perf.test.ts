import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";
import { parseKanban, computeProgress } from "./kanbanParse";
import {
  markdownToPlain,
  splitForTwitter,
  formatForJike,
  formatForXhs,
} from "@/components/popovers/MultiCopySheet";

// Performance thresholds — set conservatively. Pinned so a regression FAILS CI.
// Numbers chosen from local runs with headroom. Lower if you tighten the budget.
const BUDGET_MS = {
  frontmatter_100kb: 50,
  kanban_1000_tasks: 60,
  markdownToPlain_100kb: 80,
  splitForTwitter_50kb: 80,
  formatForJike_100kb: 80,
  formatForXhs_100kb: 100,
};

function bench(fn: () => void, runs = 3): number {
  // warm-up
  fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

function makeFrontmatter(bodyKB: number): string {
  const body = "x".repeat(bodyKB * 1024);
  return `---\ntitle: bench\ntag: perf\nauthor: chenqi\n---\n${body}`;
}

function makeKanban(numCols: number, tasksPerCol: number): string {
  const cols: string[] = [];
  for (let c = 0; c < numCols; c++) {
    cols.push(`# Column ${c}`);
    for (let t = 0; t < tasksPerCol; t++) {
      const done = t % 3 === 0 ? "x" : " ";
      cols.push(
        `- [${done}] task ${t} #project !${t % 2 === 0 ? "high" : "low"} @05-${(t % 28) + 1} ~${t}h {${(t % 10) * 10}%}`,
      );
    }
  }
  return cols.join("\n");
}

function makeMarkdown(kb: number): string {
  const para =
    "# Heading\n\nSome **bold** and *italic* text with [a link](https://example.com) " +
    "and `inline code` and ![an image](https://example.com/img.png) and a [[wiki|alias]] " +
    "and #tag for the day.\n\n";
  const target = kb * 1024;
  let out = "";
  while (out.length < target) out += para;
  return out.slice(0, target);
}

describe("perf budgets", () => {
  it(`parseFrontmatter 100KB body < ${BUDGET_MS.frontmatter_100kb}ms`, () => {
    const src = makeFrontmatter(100);
    const ms = bench(() => parseFrontmatter(src));
    console.log(`[bench] parseFrontmatter 100KB: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS.frontmatter_100kb);
  });

  it(`parseKanban 1000 tasks < ${BUDGET_MS.kanban_1000_tasks}ms`, () => {
    const src = makeKanban(10, 100);
    const ms = bench(() => {
      const cols = parseKanban(src);
      computeProgress(cols);
    });
    console.log(`[bench] parseKanban 1000 tasks: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS.kanban_1000_tasks);
  });

  it(`markdownToPlain 100KB < ${BUDGET_MS.markdownToPlain_100kb}ms`, () => {
    const src = makeMarkdown(100);
    const ms = bench(() => markdownToPlain(src));
    console.log(`[bench] markdownToPlain 100KB: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS.markdownToPlain_100kb);
  });

  it(`splitForTwitter 50KB < ${BUDGET_MS.splitForTwitter_50kb}ms`, () => {
    const src = makeMarkdown(50);
    const ms = bench(() => splitForTwitter(src, 280));
    console.log(`[bench] splitForTwitter 50KB: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS.splitForTwitter_50kb);
  });

  it(`formatForJike 100KB < ${BUDGET_MS.formatForJike_100kb}ms`, () => {
    const src = makeMarkdown(100);
    const ms = bench(() => formatForJike(src));
    console.log(`[bench] formatForJike 100KB: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS.formatForJike_100kb);
  });

  it(`formatForXhs 100KB < ${BUDGET_MS.formatForXhs_100kb}ms`, () => {
    const src = makeMarkdown(100);
    const ms = bench(() => formatForXhs(src, "Title"));
    console.log(`[bench] formatForXhs 100KB: ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(BUDGET_MS.formatForXhs_100kb);
  });
});
