import { describe, expect, it } from "vitest";
import { getMathContext } from "./math-context";

/** 极简的 EditorView 假货，只实现 getMathContext 用到的接口 */
class FakeDoc {
  readonly text: string;
  private readonly lineStarts: number[];
  constructor(text: string) {
    this.text = text;
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
    return { number, from, to, text: this.text.slice(from, to) };
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

function fakeView(text: string, cursor: number) {
  return {
    state: {
      doc: new FakeDoc(text),
      selection: { main: { head: cursor, from: cursor, to: cursor, empty: true } },
    },
    coordsAtPos: () => ({ left: 10, top: 0, right: 12, bottom: 20 }),
  } as never;
}

describe("getMathContext", () => {
  it("detects inline $...$ with cursor inside", () => {
    const text = "公式 $a + b$ 看这";
    const cursor = text.indexOf("+");
    const ctx = getMathContext(fakeView(text, cursor));
    expect(ctx).not.toBeNull();
    expect(ctx?.display).toBe(false);
    expect(ctx?.formula).toBe("a + b");
  });

  it("returns null outside any $...$", () => {
    const text = "公式 $a$ 旁边的字 $b$";
    const cursor = text.indexOf("旁");
    expect(getMathContext(fakeView(text, cursor))).toBeNull();
  });

  it("ignores escaped \\$ pairs", () => {
    const text = "价格 \\$5 与 \\$10 之间";
    const cursor = text.indexOf("与");
    expect(getMathContext(fakeView(text, cursor))).toBeNull();
  });

  it("detects display $$...$$ block when cursor is between fence lines", () => {
    const text = "前\n$$\nE = mc^2\n$$\n后";
    const cursor = text.indexOf("E");
    const ctx = getMathContext(fakeView(text, cursor));
    expect(ctx).not.toBeNull();
    expect(ctx?.display).toBe(true);
    expect(ctx?.formula).toBe("E = mc^2");
  });

  it("returns null when cursor sits on the $$ fence line itself", () => {
    const text = "前\n$$\nE = mc^2\n$$\n后";
    const cursor = text.indexOf("$$");
    expect(getMathContext(fakeView(text, cursor))).toBeNull();
  });
});
