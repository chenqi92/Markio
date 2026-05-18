// @vitest-environment happy-dom
//
// Benchmark the JS-side DOM enhancement passes that run on every preview
// update: enhanceCallouts + enhanceWikiLinks. Real markdown→HTML rendering
// happens in Rust (api.renderMarkdown), so here we synthesize HTML matching
// the shape these enhancers actually see in production, then measure their
// cost across stepped document sizes.
//
// Budgets are upper bounds: a regression that introduces O(n²) behaviour
// will blow past them. Local runs are ~10–30× under budget.
//
// Run: npm test src/lib/preview-pipeline.perf.test.ts
// Generate fixtures first: npm run perf:fixtures

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enhanceCallouts } from "./callouts";
import { enhanceWikiLinks } from "./wikilinks";
import type { VaultFile } from "@/lib/api";

const FIXTURES_DIR = path.resolve(__dirname, "../../tests/fixtures/perf");

// Synthesize HTML in the shape post-Rust-rendering: blockquotes with [!type]
// markers in their first text node, wikilinks as raw [[name]] text, plus
// plenty of paragraph / list / code-block padding.
function synthHtml(srcKB: number): string {
  const blocks: string[] = [];
  let bytes = 0;
  const target = srcKB * 1024;
  let i = 0;
  while (bytes < target) {
    const section =
      `<h2>Section ${i}</h2>` +
      `<p>这是第 ${i} 段，包含 <strong>粗体</strong>、<em>斜体</em>、` +
      `<a href="https://example.com/${i}">外链</a>、[[Section ${i - 1}|上一节]]、` +
      `[[Note ${i}]] 与 <code>inline</code>。</p>` +
      `<blockquote><p>[!note] 备注 ${i}</p><p>这是 callout 内容，含 [[Note ${i}]]。</p>` +
      `<ul><li>子要点 1</li><li>子要点 2</li></ul></blockquote>` +
      `<blockquote><p>[!warning]+ 警告 ${i}</p><p>含 [[Section ${i + 1}#sub]]。</p></blockquote>` +
      `<pre><code class="language-ts">function step${i}(x){return x*${i};}\n` +
      `// [[NotInsideCode]] should be ignored by both enhancers\n</code></pre>` +
      `<ul><li>list item ${i} with [[Item ${i}]]</li>` +
      `<li>another with <code>[[InCode]]</code></li></ul>`;
    blocks.push(section);
    bytes += section.length;
    i++;
  }
  return blocks.join("\n");
}

function makeFiles(count: number): VaultFile[] {
  const files: VaultFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push({
      path: `vault/Section ${i}.md`,
      name: `Section ${i}.md`,
      stem: `Section ${i}`,
      mtime: 0,
      size: 0,
      tags: [],
      mentions: [],
    });
    files.push({
      path: `vault/notes/Note ${i}.md`,
      name: `Note ${i}.md`,
      stem: `Note ${i}`,
      mtime: 0,
      size: 0,
      tags: [],
      mentions: [],
    });
  }
  return files;
}

function bench(fn: () => void, runs = 3): number {
  fn(); // warm-up
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

interface Step {
  label: string;
  srcKB: number;
  files: number;
  // Upper-bound budgets, ms. Calibrated to ~10–30× local timings to catch
  // algorithmic regressions without flaking on slow CI hosts.
  budgetCallouts: number;
  budgetWikilinks: number;
}

const STEPS: Step[] = [
  { label: "10KB", srcKB: 10, files: 30, budgetCallouts: 50, budgetWikilinks: 80 },
  { label: "100KB", srcKB: 100, files: 200, budgetCallouts: 250, budgetWikilinks: 400 },
  { label: "1MB", srcKB: 1024, files: 1500, budgetCallouts: 1500, budgetWikilinks: 3000 },
];

describe("preview DOM enhancement — perf budgets", () => {
  for (const step of STEPS) {
    it(`enhanceCallouts on ${step.label} HTML < ${step.budgetCallouts}ms`, () => {
      const html = synthHtml(step.srcKB);
      const root = document.createElement("div");
      const ms = bench(() => {
        root.innerHTML = html;
        enhanceCallouts(root);
      });
      console.log(`[bench] enhanceCallouts ${step.label}: ${ms.toFixed(2)}ms`);
      expect(ms).toBeLessThan(step.budgetCallouts);
      // sanity: actually enhanced something
      expect(root.querySelectorAll("blockquote.callout").length).toBeGreaterThan(0);
    });

    it(`enhanceWikiLinks on ${step.label} HTML < ${step.budgetWikilinks}ms`, () => {
      const html = synthHtml(step.srcKB);
      const files = makeFiles(step.files);
      const root = document.createElement("div");
      const ms = bench(() => {
        root.innerHTML = html;
        enhanceWikiLinks(root, files);
      });
      console.log(`[bench] enhanceWikiLinks ${step.label}: ${ms.toFixed(2)}ms`);
      expect(ms).toBeLessThan(step.budgetWikilinks);
      // sanity: produced at least some wikilinks; none inside <code>/<pre>
      expect(root.querySelectorAll("a.wikilink").length).toBeGreaterThan(0);
      const inCode = root.querySelectorAll("code a.wikilink, pre a.wikilink");
      expect(inCode.length).toBe(0);
    });
  }

  it("on-disk 100kb fixture round-trip (if generated)", () => {
    const f = path.join(FIXTURES_DIR, "100kb.md");
    if (!fs.existsSync(f)) {
      console.warn(`[skip] ${f} missing — run \`npm run perf:fixtures\``);
      return;
    }
    const md = fs.readFileSync(f, "utf8");
    expect(md.length).toBeGreaterThan(50 * 1024);
    // The actual markdown→HTML lives in Rust; this asserts the fixture is
    // present and shaped sanely (frontmatter + headings + wikilinks).
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toMatch(/^#\s+Chapter\s+\d+/m);
    expect(md).toMatch(/\[\[Section \d+/);
    expect(md).toMatch(/\[!note\]|\[!warning\]/);
  });
});
