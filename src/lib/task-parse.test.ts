import { describe, expect, it } from "vitest";
import { compareTasks, dueBucket, parseTask } from "./task-parse";

describe("parseTask", () => {
  it("returns null for non-task lines", () => {
    expect(parseTask("# heading")).toBeNull();
    expect(parseTask("just text")).toBeNull();
    expect(parseTask("- [x] done item")).toBeNull();
    expect(parseTask("    not a list")).toBeNull();
  });

  it("parses plain task", () => {
    const t = parseTask("- [ ] write tests");
    expect(t).not.toBeNull();
    expect(t?.text).toBe("write tests");
    expect(t?.tags).toEqual([]);
    expect(t?.due).toBeUndefined();
    expect(t?.priority).toBeUndefined();
  });

  it("accepts +/* list markers and leading spaces", () => {
    expect(parseTask("  + [ ] alt marker")?.text).toBe("alt marker");
    expect(parseTask("* [ ] star marker")?.text).toBe("star marker");
  });

  it("extracts tags and strips them from text", () => {
    const t = parseTask("- [ ] ship #release #v1.0 today");
    expect(t?.text).toBe("ship today");
    expect(t?.tags).toEqual(["release", "v1.0"]);
  });

  it("extracts due via @YYYY-MM-DD", () => {
    const t = parseTask("- [ ] file taxes @2026-05-30");
    expect(t?.text).toBe("file taxes");
    expect(t?.due).toBe("2026-05-30");
  });

  it("extracts due via 📅 marker", () => {
    const t = parseTask("- [ ] call mom 📅 2026-06-01");
    expect(t?.text).toBe("call mom");
    expect(t?.due).toBe("2026-06-01");
  });

  it("extracts due via trailing (YYYY-MM-DD)", () => {
    const t = parseTask("- [ ] book flight (2026-07-12)");
    expect(t?.text).toBe("book flight");
    expect(t?.due).toBe("2026-07-12");
  });

  it("extracts priority via !high/!med/!low", () => {
    expect(parseTask("- [ ] urgent !high")?.priority).toBe("high");
    expect(parseTask("- [ ] later !med")?.priority).toBe("med");
    expect(parseTask("- [ ] nice-to-have !low")?.priority).toBe("low");
  });

  it("extracts priority via emoji", () => {
    expect(parseTask("- [ ] 🔴 deploy")?.priority).toBe("high");
    expect(parseTask("- [ ] 🟡 review")?.priority).toBe("med");
    expect(parseTask("- [ ] 🟢 read RFC")?.priority).toBe("low");
  });

  it("emoji priority takes precedence over !high", () => {
    // (currently emoji is checked first)
    expect(parseTask("- [ ] 🔴 both !low")?.priority).toBe("high");
  });

  it("combines tags + due + priority", () => {
    const t = parseTask("- [ ] !high write report #q2 @2026-06-15 for board");
    expect(t?.priority).toBe("high");
    expect(t?.due).toBe("2026-06-15");
    expect(t?.tags).toEqual(["q2"]);
    expect(t?.text).toBe("write report for board");
  });
});

describe("compareTasks", () => {
  it("orders by priority first", () => {
    const a = { text: "a", tags: [], priority: "low" as const };
    const b = { text: "b", tags: [], priority: "high" as const };
    expect(compareTasks(a, b)).toBeGreaterThan(0);
  });

  it("orders by due when priority equal", () => {
    const a = { text: "a", tags: [], due: "2026-06-02" };
    const b = { text: "b", tags: [], due: "2026-05-30" };
    expect(compareTasks(a, b)).toBeGreaterThan(0);
  });
});

describe("dueBucket", () => {
  const now = new Date("2026-05-21T10:00:00Z");
  it("classifies dates correctly", () => {
    expect(dueBucket(undefined, now)).toBe("none");
    expect(dueBucket("2026-05-20", now)).toBe("overdue");
    expect(dueBucket("2026-05-21", now)).toBe("today");
    expect(dueBucket("2026-05-22", now)).toBe("tomorrow");
    expect(dueBucket("2026-05-25", now)).toBe("thisWeek");
    expect(dueBucket("2026-06-01", now)).toBe("later");
  });
});
