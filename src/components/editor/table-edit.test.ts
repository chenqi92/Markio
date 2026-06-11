import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorView } from "@codemirror/view";
import {
  applyTableAction,
  applyTableActionToText,
  clearTableRect,
  detectTable,
  moveTableCell,
  parseTabularText,
  pasteTableText,
  pasteTableTextToText,
  tableCellTextFromText,
  tableRectClipboardText,
} from "./table-edit";

class FakeDoc {
  readonly length: number;
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    this.length = text.length;
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this.lineStarts.push(i + 1);
    }
  }

  get lines() {
    return this.lineStarts.length;
  }

  line(number: number) {
    const from = this.lineStarts[number - 1] ?? 0;
    const next = this.lineStarts[number];
    const to = next == null ? this.text.length : Math.max(from, next - 1);
    return {
      number,
      from,
      to,
      text: this.text.slice(from, to),
    };
  }

  lineAt(pos: number) {
    let number = 1;
    for (let i = 0; i < this.lineStarts.length; i++) {
      if (this.lineStarts[i]! <= pos) number = i + 1;
      else break;
    }
    return this.line(number);
  }
}

function fakeView(text: string, pos: number) {
  return {
    state: {
      doc: new FakeDoc(text),
      selection: { main: { from: pos, to: pos, head: pos, empty: true } },
    },
    dispatch: vi.fn(),
  } as any;
}

const table = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");

function realView(doc: string, cursor: number): EditorView {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage })],
  });
  return { state } as unknown as EditorView;
}

describe("table detection fence-awareness", () => {
  it("does not detect a table inside a fenced code block", () => {
    const doc = "```chart\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n";
    expect(detectTable(realView(doc, doc.indexOf("| 1")))).toBeNull();
  });

  it("still detects a normal standalone table", () => {
    const doc = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    expect(detectTable(realView(doc, doc.indexOf("| 1")))).not.toBeNull();
  });
});

describe("table editing", () => {
  it("parses TSV and markdown table clipboard data", () => {
    expect(parseTabularText("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseTabularText("| A | B |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  it("pastes TSV into the current cell and expands the table", () => {
    const view = fakeView(table, table.indexOf("2"));

    expect(pasteTableText(view, "x\ty\nz\tw")).toBe(true);

    const change = view.dispatch.mock.calls[0][0].changes;
    expect(change.insert).toContain("| A | B |   |");
    expect(change.insert).toContain("| 1 | x | y |");
    expect(change.insert).toContain("|   | z | w |");
  });

  it("copies and clears a rectangular table selection", () => {
    const view = fakeView(table, table.indexOf("A"));
    const rect = { tableFrom: 0, startRow: 0, endRow: 1, startCol: 0, endCol: 1 };

    expect(tableRectClipboardText(view, rect)).toBe("A\tB\n1\t2");
    expect(clearTableRect(view, rect)).toBe(true);

    const change = view.dispatch.mock.calls[0][0].changes;
    expect(change.insert).toContain("|   |   |");
  });

  it("pastes TSV from an explicit table cell coordinate", () => {
    const view = fakeView(table, table.indexOf("A"));

    expect(pasteTableText(view, "x\ty", { row: 1, col: 0 })).toBe(true);

    const change = view.dispatch.mock.calls[0][0].changes;
    expect(change.insert).toContain("| x | y |");
  });

  it("tabbing past the last cell appends a new row", () => {
    const view = fakeView(table, table.indexOf("2"));

    expect(moveTableCell(view, "next")).toBe(true);

    const change = view.dispatch.mock.calls[0][0].changes;
    expect(change.insert).toContain("| 1 | 2 |");
    expect(change.insert).toContain("|   |   |");
  });

  it("moves columns and sorts rows by the current column", () => {
    const source = [
      "| Name | Score |",
      "| --- | ---: |",
      "| B | 2 |",
      "| A | 10 |",
    ].join("\n");
    const scoreView = fakeView(source, source.indexOf("Score"));

    expect(applyTableAction(scoreView, { type: "moveColLeft" })).toBe(true);
    expect(scoreView.dispatch.mock.calls[0][0].changes.insert).toContain(
      "| Score | Name |",
    );

    const dataView = fakeView(source, source.indexOf("2"));
    expect(applyTableAction(dataView, { type: "sortDesc" })).toBe(true);
    const sorted = dataView.dispatch.mock.calls[0][0].changes.insert;
    expect(sorted.indexOf("| A | 10 |")).toBeLessThan(sorted.indexOf("| B | 2 |"));
  });

  it("applies preview table actions without an editor view", () => {
    const source = ["before", table, "after"].join("\n\n");

    expect(
      applyTableActionToText(source, 0, { row: 1, col: 1 }, { type: "insertColRight" }),
    ).toContain("| A | B |   |");

    const deleted = applyTableActionToText(source, 0, { row: 1, col: 0 }, { type: "deleteRow" });
    expect(deleted).toContain("| A | B |");
    expect(deleted).not.toContain("| 1 | 2 |");
    expect(deleted).toContain("before");
    expect(deleted).toContain("after");
  });

  it("preserves the newline after the table (no line merge)", () => {
    // 表格紧跟一行文本（无空行），编辑后末行不能与 after 黏在一起
    const src = "| A | B |\n| --- | --- |\n| 1 | 2 |\nafter";
    const out = applyTableActionToText(src, 0, { row: 1, col: 1 }, { type: "insertColRight" });
    expect(out).toBeTruthy();
    expect(out).not.toContain("|after");
    expect(out).toMatch(/\|\s*\nafter/);
    // 反复编辑不应持续吞换行
    const out2 = applyTableActionToText(out!, 0, { row: 1, col: 1 }, { type: "insertColRight" });
    expect(out2).not.toContain("|after");
    expect(out2).toContain("\nafter");
  });

  it("copies and pastes preview table cells without an editor view", () => {
    const source = ["before", table, "after"].join("\n\n");

    expect(tableCellTextFromText(source, 0, { row: 1, col: 1 })).toBe("2");

    const pasted = pasteTableTextToText(source, 0, { row: 1, col: 0 }, "x\ty\nz\tw");
    expect(pasted).toContain("| A | B |");
    expect(pasted).toContain("| x | y |");
    expect(pasted).toContain("| z | w |");
    expect(pasted).toContain("before");
    expect(pasted).toContain("after");
  });
});
