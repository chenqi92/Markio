import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cursorInsideRange, detectMathRanges } from "./math-ranges";

describe("detectMathRanges — inline", () => {
  it("finds a single inline math", () => {
    const r = detectMathRanges("text $x^2$ tail");
    expect(r).toEqual([
      { from: 5, to: 10, source: "x^2", display: false },
    ]);
  });

  it("ignores escaped $", () => {
    expect(detectMathRanges("price: \\$5 and \\$10")).toEqual([]);
  });

  it("ignores $ inside inline code", () => {
    expect(detectMathRanges("see `$x$` literal")).toEqual([]);
  });

  it("ignores $ inside fenced code block", () => {
    expect(detectMathRanges("```\n$x$\n```\nafter")).toEqual([]);
  });

  it("finds multiple inline maths on one line", () => {
    const r = detectMathRanges("$a$ and $b$");
    expect(r).toHaveLength(2);
    expect(r[0].source).toBe("a");
    expect(r[1].source).toBe("b");
  });

  it("does not cross a newline", () => {
    expect(detectMathRanges("$foo\nbar$")).toEqual([]);
  });

  it("rejects empty $$ as inline", () => {
    // $$ at line-internal position should not be treated as inline math
    expect(detectMathRanges("hello $$ world")).toEqual([]);
  });
});

describe("detectMathRanges — block", () => {
  it("finds a block at file start", () => {
    const src = "$$\n\\sum_{i=1}^{n} i = n\n$$\n";
    const r = detectMathRanges(src);
    expect(r).toHaveLength(1);
    expect(r[0].display).toBe(true);
    expect(r[0].source).toBe("\\sum_{i=1}^{n} i = n");
    expect(r[0].from).toBe(0);
  });

  it("finds a block in the middle of a doc", () => {
    const src = "para\n\n$$\nx^2\n$$\n\nafter";
    const r = detectMathRanges(src);
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe("x^2");
  });

  it("requires $$ on its own line (rejects inline-like)", () => {
    // `$$x^2$$` on a single line is NOT block math here
    expect(detectMathRanges("text $$x^2$$ tail")).toEqual([]);
  });

  it("supports leading whitespace on the closing line", () => {
    const src = "$$\nfoo\n  $$\n";
    const r = detectMathRanges(src);
    expect(r).toHaveLength(1);
    expect(r[0].source).toBe("foo");
  });

  it("ignores unterminated block", () => {
    expect(detectMathRanges("$$\nno close here")).toEqual([]);
  });

  it("does not detect block inside fenced code", () => {
    const src = "```\n$$\nx\n$$\n```";
    expect(detectMathRanges(src)).toEqual([]);
  });
});

describe("detectMathRanges — invariants", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        detectMathRanges(s);
      }),
      { numRuns: 500 },
    );
  });

  it("ranges are well-ordered and non-overlapping", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const ranges = detectMathRanges(s);
        let prevTo = -1;
        for (const r of ranges) {
          expect(r.from).toBeGreaterThanOrEqual(0);
          expect(r.to).toBeGreaterThan(r.from);
          expect(r.to).toBeLessThanOrEqual(s.length);
          expect(r.from).toBeGreaterThanOrEqual(prevTo);
          prevTo = r.to;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("inner source is the substring between delimiters (trimmed)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const ranges = detectMathRanges(s);
        for (const r of ranges) {
          const raw = s.slice(r.from, r.to);
          if (r.display) {
            expect(raw.startsWith("$$")).toBe(true);
            expect(raw.includes("$$\n") || raw.trimEnd().endsWith("$$")).toBe(true);
          } else {
            expect(raw.startsWith("$")).toBe(true);
            expect(raw.endsWith("$")).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("cursorInsideRange", () => {
  it("treats boundary as inside (so user can edit delimiter)", () => {
    const r = { from: 5, to: 10, source: "x", display: false };
    expect(cursorInsideRange(r, 5)).toBe(true);
    expect(cursorInsideRange(r, 10)).toBe(true);
    expect(cursorInsideRange(r, 7)).toBe(true);
    expect(cursorInsideRange(r, 4)).toBe(false);
    expect(cursorInsideRange(r, 11)).toBe(false);
  });
});
