import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  formatForJike,
  formatForMarkdownPaste,
  formatForXhs,
  markdownToPlain,
  splitForTwitter,
} from "./MultiCopySheet";

describe("multi-copy formatters — properties", () => {
  it("markdownToPlain never throws and never returns null/undefined", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = markdownToPlain(s);
        expect(typeof out).toBe("string");
      }),
      { numRuns: 300 },
    );
  });

  it("markdownToPlain is idempotent (plain → plain unchanged)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = markdownToPlain(s);
        const twice = markdownToPlain(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  it("markdownToPlain strips backticks and headings", () => {
    expect(markdownToPlain("# Hi\n`code`")).toBe("Hi\ncode");
  });

  it("formatForMarkdownPaste is idempotent and = trim()", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const a = formatForMarkdownPaste(s);
        expect(a).toBe(s.trim());
        expect(formatForMarkdownPaste(a)).toBe(a);
      }),
      { numRuns: 200 },
    );
  });

  it("formatForJike never throws", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        formatForJike(s);
      }),
      { numRuns: 300 },
    );
  });

  it("formatForXhs always has a title when source has no heading", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9 ]{0,40}$/).filter((s) => !s.includes("#")),
        fc.stringMatching(/^[A-Za-z0-9 ]{0,20}$/),
        (body, fallback) => {
          const out = formatForXhs(body, fallback);
          const expected = fallback.trim() || "无标题";
          expect(out.startsWith(expected)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("formatForXhs falls back to 无标题 when fallback is whitespace", () => {
    expect(formatForXhs("", "   ").startsWith("无标题")).toBe(true);
    expect(formatForXhs("", "").startsWith("无标题")).toBe(true);
  });

  describe("splitForTwitter", () => {
    it("output contains all original characters (modulo separators)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 600 }).filter((s) => s.trim().length > 0),
          fc.integer({ min: 40, max: 280 }),
          (text, limit) => {
            const out = splitForTwitter(text, limit);
            // every non-whitespace char from source appears at least once
            const collapsed = out.replace(/\d+\/\d+/g, "").replace(/———/g, "");
            const sourceLetters = text.replace(/\s+/g, "");
            const outLetters = collapsed.replace(/\s+/g, "");
            // outLetters should contain every char of source preserving order
            let j = 0;
            for (const ch of sourceLetters) {
              const idx = outLetters.indexOf(ch, j);
              if (idx < 0) throw new Error(`lost char ${JSON.stringify(ch)}`);
              j = idx + 1;
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("numbers parts 1/N..N/N consistently", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 400 }).filter((s) => s.trim().length > 0),
          fc.integer({ min: 40, max: 280 }),
          (text, limit) => {
            const out = splitForTwitter(text, limit);
            const m = out.match(/^(\d+)\/(\d+)/);
            if (!m) return; // empty case
            const total = Number(m[2]);
            for (let i = 1; i <= total; i++) {
              expect(out.includes(`${i}/${total}`)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
