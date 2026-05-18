// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseTableSource, type ParsedTable } from "./wysiwyg";

const expectShape = (t: ParsedTable, header: string[], rows: string[][]) => {
  expect(t.header).toEqual(header);
  expect(t.rows).toEqual(rows);
};

describe("parseTableSource", () => {
  it("parses a basic 2-column table", () => {
    const src = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";
    const t = parseTableSource(src);
    expectShape(t, ["A", "B"], [
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(t.aligns).toEqual([null, null]);
  });

  it("captures column alignments", () => {
    const src = "| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |";
    const t = parseTableSource(src);
    expect(t.aligns).toEqual(["left", "center", "right"]);
  });

  it("trims whitespace inside cells", () => {
    const src = "|   x   |   y   |\n|---|---|\n|  hello  |  world  |";
    const t = parseTableSource(src);
    expect(t.header).toEqual(["x", "y"]);
    expect(t.rows[0]).toEqual(["hello", "world"]);
  });

  it("ignores blank lines and lines without leading |", () => {
    const src = "para\n\n| A | B |\n|---|---|\n| 1 | 2 |\nfooter";
    const t = parseTableSource(src);
    expect(t.header).toEqual(["A", "B"]);
    expect(t.rows).toEqual([["1", "2"]]);
  });

  it("returns empty when fewer than 2 table-like lines", () => {
    const t = parseTableSource("| A |\nno separator");
    expect(t.header).toEqual([]);
    expect(t.rows).toEqual([]);
  });

  it("handles single-row table (no body)", () => {
    const t = parseTableSource("| A | B |\n|---|---|");
    expect(t.header).toEqual(["A", "B"]);
    expect(t.rows).toEqual([]);
  });
});
