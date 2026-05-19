import { describe, expect, it } from "vitest";
import { findTextRanges } from "./findText";

const defaults = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

describe("findTextRanges", () => {
  it("finds literal matches case-insensitively by default", () => {
    expect(findTextRanges("Alpha alpha ALPHA", "alpha", defaults).matches).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ]);
  });

  it("honors case-sensitive literal matching", () => {
    expect(
      findTextRanges("Alpha alpha ALPHA", "alpha", {
        ...defaults,
        caseSensitive: true,
      }).matches,
    ).toEqual([{ from: 6, to: 11 }]);
  });

  it("filters literal matches to whole words", () => {
    expect(
      findTextRanges("cat scatter cat_ cat", "cat", {
        ...defaults,
        wholeWord: true,
      }).matches,
    ).toEqual([
      { from: 0, to: 3 },
      { from: 17, to: 20 },
    ]);
  });

  it("uses regular expressions when enabled", () => {
    expect(
      findTextRanges("v1 v22 vx", "v\\d+", {
        ...defaults,
        regex: true,
      }).matches,
    ).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 6 },
    ]);
  });

  it("returns a validation error for invalid regular expressions", () => {
    const result = findTextRanges("abc", "(", {
      ...defaults,
      regex: true,
    });

    expect(result.matches).toEqual([]);
    expect(result.error).toMatch(/Invalid regular expression/);
  });
});
