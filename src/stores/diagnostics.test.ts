import { beforeEach, describe, expect, it } from "vitest";
import { reportDiagnostic, useDiagnostics } from "./diagnostics";

beforeEach(() => {
  useDiagnostics.setState({ items: [] });
});

describe("diagnostics store", () => {
  it("records unseen background issues", () => {
    reportDiagnostic({
      source: "sync",
      severity: "error",
      message: "Git 同步失败",
      detail: "pull failed",
      workspace: "/repo",
    });
    const item = useDiagnostics.getState().items[0]!;
    expect(item.source).toBe("sync");
    expect(item.severity).toBe("error");
    expect(item.seen).toBe(false);
    expect(item.detail).toBe("pull failed");
  });

  it("dedupes repeated issues in a short window", () => {
    reportDiagnostic({ source: "rag", message: "索引失败", detail: "first" });
    reportDiagnostic({ source: "rag", message: "索引失败", detail: "second" });
    const items = useDiagnostics.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toBe("second");
  });

  it("can mark issues as seen", () => {
    reportDiagnostic({ source: "history", message: "快照失败" });
    useDiagnostics.getState().markAllSeen();
    expect(useDiagnostics.getState().items[0]!.seen).toBe(true);
  });
});
