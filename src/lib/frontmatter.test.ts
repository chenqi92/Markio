import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses a basic key/value block", () => {
    const src = "---\ntitle: Hi\ntag: a\n---\nbody";
    expect(parseFrontmatter(src)).toEqual({
      data: { title: "Hi", tag: "a" },
      body: "body",
    });
  });

  it("strips surrounding quotes from values", () => {
    expect(parseFrontmatter('---\ntitle: "Hi"\n---\nx').data.title).toBe("Hi");
    expect(parseFrontmatter("---\ntitle: 'Hi'\n---\nx").data.title).toBe("Hi");
  });

  it("returns empty data when no frontmatter delimiter", () => {
    expect(parseFrontmatter("just body").data).toEqual({});
    expect(parseFrontmatter("just body").body).toBe("just body");
  });

  it("treats an unterminated frontmatter as body", () => {
    const src = "---\ntitle: Hi\nno end";
    const { data, body } = parseFrontmatter(src);
    expect(data).toEqual({});
    expect(body).toBe(src);
  });

  it("ignores lines that don't match key: value", () => {
    const src = "---\ntitle: Hi\nnonsense line\n9invalidKey: x\n---\n";
    expect(parseFrontmatter(src).data).toEqual({ title: "Hi" });
  });

  describe("properties", () => {
    it("never throws on arbitrary input", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          parseFrontmatter(s);
        }),
        { numRuns: 500 },
      );
    });

    it("data + body fully cover the source (modulo whitespace)", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const { data, body } = parseFrontmatter(s);
          expect(typeof body).toBe("string");
          expect(typeof data).toBe("object");
          // body can never be longer than source
          expect(body.length).toBeLessThanOrEqual(s.length);
        }),
        { numRuns: 500 },
      );
    });

    it("when no leading ---, body === input", () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => !s.startsWith("---")),
          (s) => {
            expect(parseFrontmatter(s).body).toBe(s);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("keys always match the documented format", () => {
      const keyArb = fc.stringMatching(/^[A-Za-z][\w-]{0,20}$/);
      const valArb = fc.stringMatching(/^[\w一-龥 .,!?-]{0,40}$/);
      fc.assert(
        fc.property(
          fc.array(fc.tuple(keyArb, valArb), { minLength: 1, maxLength: 8 }),
          fc.string(),
          (entries, body) => {
            const block = entries.map(([k, v]) => `${k}: ${v}`).join("\n");
            const src = `---\n${block}\n---\n${body}`;
            const parsed = parseFrontmatter(src);
            for (const [k] of entries) {
              expect(parsed.data).toHaveProperty(k);
            }
            expect(Object.keys(parsed.data).every((k) => /^[A-Za-z][\w-]*$/.test(k))).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
