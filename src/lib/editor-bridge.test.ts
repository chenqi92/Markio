import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
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
      if (this.lineStarts[i]! <= pos) number = i + 1;
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

// 用真实 EditorState（带 markdown 解析）验证围栏外重定向：fake doc 取不到语法树，
// 只有真状态能命中 fenceBoundaryAfter。
function mountRealEditor(text: string, cursor: number) {
  const state = EditorState.create({
    doc: text,
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage })],
  });
  const dispatch = vi.fn();
  registerEditor({ state, dispatch, focus: vi.fn() } as never);
  return dispatch;
}

describe("editor bridge fenced-block redirect", () => {
  afterEach(() => registerEditor(null));

  it("redirects insertion to after the closing fence when cursor is inside it", () => {
    const doc = "```chart\n{\"type\":\"bar\"}\n```\n";
    const cursor = doc.indexOf("type"); // 光标落在围栏体里
    const dispatch = mountRealEditor(doc, cursor);

    insertBlock("```server\nhost: 1.1.1.1\n```", {
      atLineStart: true,
      ensureBlankLines: true,
    });

    const closeFenceEnd = doc.indexOf("```", 3) + 3; // 结束 ``` 行尾
    const call = dispatch.mock.calls[0]![0] as {
      changes: { from: number; to: number; insert: string };
    };
    expect(call.changes.from).toBe(closeFenceEnd);
    expect(call.changes.to).toBe(closeFenceEnd);
    // 新内容应在围栏外，不会把 server 块塞进 chart 围栏里
    expect(call.changes.insert).toContain("```server");
  });

  it("redirects when cursor sits right after the fence (block-widget end boundary)", () => {
    // 图表是最后一个块、无尾随换行：光标停在围栏末尾（doc 末）。插入应落到围栏
    // 之外（doc 末），而不是被 atLineStart 拉到结束 ``` 行首、塞进围栏里。
    const doc = "```chart\n{\"type\":\"bar\"}\n```";
    const dispatch = mountRealEditor(doc, doc.length);

    insertBlock("```chart\n{\"type\":\"pie\"}\n```", {
      atLineStart: true,
      ensureBlankLines: true,
    });

    const call = dispatch.mock.calls[0]![0] as {
      changes: { from: number; to: number };
    };
    expect(call.changes.from).toBe(doc.length);
  });

  it("inserts before the chart when cursor is at the fence start boundary", () => {
    const doc = "```chart\n{\"type\":\"bar\"}\n```";
    const dispatch = mountRealEditor(doc, 0);

    insertBlock("文字", { atLineStart: true, ensureBlankLines: true });

    const call = dispatch.mock.calls[0]![0] as {
      changes: { from: number; to: number };
    };
    expect(call.changes.from).toBe(0);
  });

  it("leaves ordinary paragraph insertion at the line start", () => {
    const doc = "hello world\n";
    const dispatch = mountRealEditor(doc, 6);

    insertBlock("| A |\n| --- |", { atLineStart: true, ensureBlankLines: true });

    const call = dispatch.mock.calls[0]![0] as {
      changes: { from: number; to: number };
    };
    expect(call.changes.from).toBe(0);
  });
});
