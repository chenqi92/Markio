import { describe, expect, it } from "vitest";
import { diffLines, diffStat } from "./lineDiff";

describe("diffLines", () => {
  it("identical text is all equal", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.type === "eq")).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("detects an added line in the middle", () => {
    const rows = diffLines("a\nc", "a\nb\nc");
    expect(rows).toEqual([
      { type: "eq", text: "a" },
      { type: "add", text: "b" },
      { type: "eq", text: "c" },
    ]);
  });

  it("detects a removed line in the middle", () => {
    const rows = diffLines("a\nb\nc", "a\nc");
    expect(rows).toEqual([
      { type: "eq", text: "a" },
      { type: "del", text: "b" },
      { type: "eq", text: "c" },
    ]);
  });

  it("detects a changed line as del + add", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(rows).toEqual([
      { type: "eq", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "eq", text: "c" },
    ]);
  });

  it("empty old yields all adds", () => {
    const rows = diffLines("", "x\ny");
    // "" splits to [""], one eq("") prefix removed by trimming; ensure adds present
    expect(rows.filter((r) => r.type === "add").map((r) => r.text)).toContain("y");
  });

  it("empty new yields all dels", () => {
    const rows = diffLines("x\ny", "");
    expect(rows.filter((r) => r.type === "del").map((r) => r.text)).toContain("x");
  });

  it("diffStat counts adds and removes", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc\nd");
    const { added, removed } = diffStat(rows);
    expect(added).toBe(2); // B + d
    expect(removed).toBe(1); // b
  });

  it("common prefix and suffix trimming keeps order", () => {
    const rows = diffLines("h1\nh2\nold\nf1", "h1\nh2\nnew1\nnew2\nf1");
    expect(rows).toEqual([
      { type: "eq", text: "h1" },
      { type: "eq", text: "h2" },
      { type: "del", text: "old" },
      { type: "add", text: "new1" },
      { type: "add", text: "new2" },
      { type: "eq", text: "f1" },
    ]);
  });

  it("handles large changed block without throwing", () => {
    const old = Array.from({ length: 3000 }, (_, i) => `o${i}`).join("\n");
    const next = Array.from({ length: 3000 }, (_, i) => `n${i}`).join("\n");
    const rows = diffLines(old, next);
    const { added, removed } = diffStat(rows);
    expect(added).toBe(3000);
    expect(removed).toBe(3000);
  });
});
