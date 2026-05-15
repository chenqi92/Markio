import { afterEach, describe, expect, it, vi } from "vitest";
import { insertBlock, registerEditor } from "./editor-bridge";

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

  sliceString(from: number, to: number) {
    return this.text.slice(from, to);
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
      if (this.lineStarts[i] <= pos) number = i + 1;
      else break;
    }
    return this.line(number);
  }
}

function mountFakeEditor(text: string, from: number, to = from) {
  const dispatch = vi.fn();
  registerEditor({
    state: {
      doc: new FakeDoc(text),
      selection: { main: { from, to, empty: from === to } },
    },
    dispatch,
    focus: vi.fn(),
  } as any);
  return dispatch;
}

describe("editor bridge block insertion", () => {
  afterEach(() => registerEditor(null));

  it("inserts a block at line start without deleting text before the cursor", () => {
    const dispatch = mountFakeEditor("hello world", 6);

    insertBlock("| A |\n| --- |", {
      atLineStart: true,
      ensureBlankLines: true,
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({ from: 0, to: 0 }),
      }),
    );
  });

  it("reuses an empty line and selects the requested placeholder", () => {
    const dispatch = mountFakeEditor("before\n\nafter", 7);

    insertBlock("| 列 A | 列 B |\n| --- | --- |\n| 内容 | 内容 |", {
      atLineStart: true,
      ensureBlankLines: true,
      selectText: "列 A",
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({ from: 7, to: 7 }),
        selection: { anchor: 10, head: 13 },
      }),
    );
  });
});
