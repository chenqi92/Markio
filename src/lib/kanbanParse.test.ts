import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  appendTaskToColumn,
  computeProgress,
  parseKanban,
  toggleTaskInSource,
} from "./kanbanParse";

describe("parseKanban — examples", () => {
  it("parses headings as columns", () => {
    const body = "# 📥 Inbox\n- [ ] one\n- [x] two\n# Done\n- [x] three";
    const cols = parseKanban(body);
    expect(cols).toHaveLength(2);
    expect(cols[0]!.title).toBe("Inbox");
    expect(cols[0]!.emoji).toBe("📥");
    expect(cols[0]!.tasks.map((t) => t.text)).toEqual(["one", "two"]);
    expect(cols[0]!.tasks[1]!.done).toBe(true);
  });

  it("extracts inline meta tokens", () => {
    const cols = parseKanban("# A\n- [ ] write doc #docs !high @05-20 ~2h {30%}");
    const t = cols[0]!.tasks[0]!;
    expect(t.text).toBe("write doc");
    expect(t.tag).toBe("docs");
    expect(t.prio).toBe("high");
    expect(t.due).toBe("05-20");
    expect(t.est).toBe("2h");
    expect(t.progress).toBe(30);
  });

  it("clamps progress > 100", () => {
    const cols = parseKanban("# A\n- [ ] x {999%}");
    expect(cols[0]!.tasks[0]!.progress).toBe(100);
  });

  it("ignores body text that isn't a column heading or task", () => {
    const cols = parseKanban("random text\n# Col\nmore text\n- [ ] only this");
    expect(cols).toHaveLength(1);
    expect(cols[0]!.tasks).toHaveLength(1);
  });
});

describe("parseKanban — properties", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        parseKanban(s);
      }),
      { numRuns: 500 },
    );
  });

  it("progress is always in [0,100] when present", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const cols = parseKanban(s);
        for (const c of cols) {
          for (const t of c.tasks) {
            if (t.progress !== undefined) {
              expect(t.progress).toBeGreaterThanOrEqual(0);
              expect(t.progress).toBeLessThanOrEqual(100);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("task lineIndex always points back at a task line in source", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const cols = parseKanban(s);
        const lines = s.split("\n");
        for (const c of cols) {
          for (const t of c.tasks) {
            expect(lines[t.lineIndex]).toBe(t.raw);
            expect(/^\s*[-*]\s+\[[ xX]\]/.test(t.raw)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("computeProgress", () => {
  it("0/0 → 0%", () => {
    expect(computeProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
  });

  it("pct ∈ [0,100] for any kanban", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const p = computeProgress(parseKanban(s));
        expect(p.pct).toBeGreaterThanOrEqual(0);
        expect(p.pct).toBeLessThanOrEqual(100);
        expect(p.done).toBeLessThanOrEqual(p.total);
      }),
      { numRuns: 200 },
    );
  });
});

describe("toggleTaskInSource — involutive", () => {
  it("toggle then toggle returns to original task state (body-only sources)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.boolean(), // initial done state
            fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/),
          ),
          { minLength: 1, maxLength: 10 },
        ),
        (tasks) => {
          const body =
            "# Col\n" +
            tasks.map(([done, text]) => `- [${done ? "x" : " "}] ${text}`).join("\n");
          const cols = parseKanban(body);
          if (cols[0]!.tasks.length === 0) return;
          const first = cols[0]!.tasks[0]!;
          const once = toggleTaskInSource(body, body, first);
          expect(once).not.toBeNull();
          // re-parse to get the new task state, then toggle back
          const cols2 = parseKanban(once!);
          const flipped = cols2[0]!.tasks[0]!;
          expect(flipped.done).toBe(!first.done);
          const twice = toggleTaskInSource(once!, once!, flipped);
          expect(twice).toBe(body);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("appendTaskToColumn", () => {
  it("appends a new unchecked task at end of named column", () => {
    const body = "# A\n- [ ] one\n# B\n- [ ] two";
    const out = appendTaskToColumn(body, body, "A", "fresh");
    expect(out).toContain("- [ ] one\n- [ ] fresh\n# B");
  });

  it("returns null when column missing", () => {
    expect(appendTaskToColumn("# A\n", "# A\n", "Nope", "x")).toBeNull();
  });
});
