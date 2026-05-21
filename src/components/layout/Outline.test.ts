import { describe, expect, it } from "vitest";

// 把内部纯函数提到本测试旁边复制（避免拆 Outline.tsx）
function computeHeadingSpans(content: string) {
  const lines = content.split("\n");
  const headings: { line: number; level: number; offset: number }[] = [];
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*```/.test(ln)) inFence = !inFence;
    if (!inFence) {
      const m = /^(#{1,6})[ \t]+\S/.exec(ln);
      if (m) {
        headings.push({ line: i, level: m[1]!.length, offset });
      }
    }
    offset += ln.length + 1;
  }
  const totalLen = content.length;
  return headings.map((h, i) => {
    let to = totalLen;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        to = headings[j]!.offset;
        break;
      }
    }
    return { from: h.offset, to, level: h.level };
  });
}

function moveSection(
  content: string,
  from: number,
  to: number,
  insertBefore: number,
): string {
  if (insertBefore >= from && insertBefore < to) return content;
  const section = content.slice(from, to);
  const without = content.slice(0, from) + content.slice(to);
  const adj = insertBefore > to ? insertBefore - (to - from) : insertBefore;
  return without.slice(0, adj) + section + without.slice(adj);
}

describe("computeHeadingSpans", () => {
  it("ignores headings inside fenced code", () => {
    const src = "# Real\n```\n# Fake\n```\n# Also Real\n";
    const spans = computeHeadingSpans(src);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.level).toBe(1);
  });

  it("computes span end at next same-or-higher-level heading", () => {
    const src = "# A\nbody A\n## A1\nbody A1\n# B\n";
    const spans = computeHeadingSpans(src);
    expect(spans[0]!.level).toBe(1);
    // section A includes A1
    const aText = src.slice(spans[0]!.from, spans[0]!.to);
    expect(aText).toContain("# A");
    expect(aText).toContain("## A1");
    expect(aText).not.toContain("# B");
  });
});

describe("moveSection", () => {
  it("moves earlier section after later", () => {
    const src = "# A\nbodyA\n# B\nbodyB\n";
    const spans = computeHeadingSpans(src);
    const next = moveSection(src, spans[0]!.from, spans[0]!.to, spans[1]!.to);
    expect(next.indexOf("# B")).toBeLessThan(next.indexOf("# A"));
  });

  it("noop when insertBefore inside the moved range", () => {
    const src = "# A\nbodyA\n# B\n";
    const spans = computeHeadingSpans(src);
    const next = moveSection(src, spans[0]!.from, spans[0]!.to, spans[0]!.from + 1);
    expect(next).toBe(src);
  });
});
