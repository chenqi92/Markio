import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseWikiLinkBody, resolveWikiFile } from "./wikilinks";
import type { VaultFile } from "@/lib/api";

const makeFile = (path: string): VaultFile => {
  const name = path.split("/").pop() ?? path;
  const stem = name.replace(/\.md$/i, "");
  return { path, name, stem, mtime: 0, size: 0, tags: [], mentions: [] };
};

describe("parseWikiLinkBody (property)", () => {
  it("never throws on any input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        parseWikiLinkBody(s);
      }),
      { numRuns: 500 },
    );
  });

  it("returns null on whitespace-only / empty", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.trim() === ""),
        (s) => {
          expect(parseWikiLinkBody(s)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("target is always non-empty when result is non-null", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const parsed = parseWikiLinkBody(s);
        if (parsed) {
          expect(parsed.target.length).toBeGreaterThan(0);
          expect(parsed.display.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("alias after `|` overrides display (alias is trimmed)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][\w-]{0,20}$/),
        fc.stringMatching(/^[\w一-龥]([\w一-龥 ]{0,18}[\w一-龥])?$/),
        (target, alias) => {
          const parsed = parseWikiLinkBody(`${target}|${alias}`);
          expect(parsed?.target).toBe(target);
          expect(parsed?.display).toBe(alias);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("alias whitespace is trimmed", () => {
    expect(parseWikiLinkBody("A|  foo  ")?.display).toBe("foo");
  });

  it("heading after `#` is captured separately", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][\w-]{0,15}$/),
        fc.stringMatching(/^[A-Za-z][\w -]{0,15}$/),
        (target, heading) => {
          const parsed = parseWikiLinkBody(`${target}#${heading}`);
          expect(parsed?.target).toBe(target);
          expect(parsed?.heading).toBe(heading.trim());
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("resolveWikiFile (property)", () => {
  it("never throws on garbage input", () => {
    const files = [makeFile("a/b.md"), makeFile("中文/笔记.md")];
    fc.assert(
      fc.property(fc.string(), (s) => {
        resolveWikiFile(files, s);
      }),
      { numRuns: 300 },
    );
  });

  it("resolves stem case-insensitively", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,15}$/), (stem) => {
        const file = makeFile(`vault/${stem}.md`);
        const found = resolveWikiFile([file], stem.toLowerCase());
        expect(found?.path).toBe(file.path);
        const found2 = resolveWikiFile([file], stem.toUpperCase());
        expect(found2?.path).toBe(file.path);
      }),
      { numRuns: 100 },
    );
  });

  it("empty / unmatched target → null", () => {
    expect(resolveWikiFile([makeFile("a.md")], "")).toBeNull();
    expect(resolveWikiFile([makeFile("a.md")], "   ")).toBeNull();
    expect(resolveWikiFile([makeFile("a.md")], "nope")).toBeNull();
    expect(resolveWikiFile(undefined, "a")).toBeNull();
    expect(resolveWikiFile([], "a")).toBeNull();
  });
});
