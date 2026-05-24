// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  applyWysiwygTableAction,
  buildTableDom,
  buildTableSource,
  parseTableSource,
} from "./wysiwyg";

const TABLE =
  "| A | B | C |\n" +
  "|:--|:-:|--:|\n" +
  "| 1 | 2 | 3 |\n" +
  "| 4 | 5 | 6 |\n";

describe("WYSIWYG table DOM", () => {
  it("renders editable cells with stable row and column coordinates", () => {
    const dom = buildTableDom(parseTableSource(TABLE));
    const cells = Array.from(dom.querySelectorAll<HTMLElement>(".cm-md-table-cell"));

    expect(dom.getAttribute("contenteditable")).toBe("false");
    expect(cells).toHaveLength(9);
    expect(cells[0]!.dataset.row).toBe("0");
    expect(cells[0]!.dataset.col).toBe("0");
    expect(cells[0]!.tagName).toBe("TEXTAREA");
    expect((cells[0] as HTMLTextAreaElement).value).toBe("A");
    expect((cells[4] as HTMLTextAreaElement).value).toBe("2");
    expect(cells[4]!.dataset.row).toBe("1");
    expect(cells[4]!.dataset.col).toBe("1");
  });

  it("renders edge insertion buttons and a contextual menu host", () => {
    const dom = buildTableDom(parseTableSource(TABLE));
    const actions = Array.from(
      dom.querySelectorAll<HTMLButtonElement>(".cm-md-table-edge-action"),
    ).map(
      (button) => button.dataset.action,
    );

    expect(actions).toEqual(["insertColRight", "insertRowBelow"]);
    expect(dom.querySelector(".cm-md-table-menu")).not.toBeNull();
  });

  it("maps alignment row to table cell text alignment", () => {
    const dom = buildTableDom(parseTableSource(TABLE));
    const header = Array.from(dom.querySelectorAll<HTMLElement>("th"));

    expect(header[0]!.style.textAlign).toBe("left");
    expect(header[1]!.style.textAlign).toBe("center");
    expect(header[2]!.style.textAlign).toBe("right");
  });
});

describe("WYSIWYG table source updates", () => {
  it("generates markdown for toolbar-driven row insertion", () => {
    const parsed = parseTableSource(TABLE);
    const next = applyWysiwygTableAction(parsed, 1, 1, "insertRowBelow");

    expect(next.rows).toEqual([
      ["1", "2", "3"],
      ["", "", ""],
      ["4", "5", "6"],
    ]);
    expect(buildTableSource(next)).toContain("| 1 | 2 | 3 |");
  });

  it("generates markdown for toolbar-driven column insertion", () => {
    const parsed = parseTableSource(TABLE);
    const next = applyWysiwygTableAction(parsed, 1, 1, "insertColRight");

    expect(next.header).toEqual(["A", "B", "", "C"]);
    expect(buildTableSource(next)).toContain("| :--- | :---: | --- | ---: |");
  });
});
