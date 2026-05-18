import { beforeEach, describe, expect, it } from "vitest";
import { reportDiagnostic, useDiagnostics } from "./diagnostics";

beforeEach(() => {
  useDiagnostics.setState({ items: [] });
});

describe("diagnostics — regression invariants", () => {
  it("caps the queue at 30 items, dropping oldest", () => {
    for (let i = 0; i < 35; i++) {
      reportDiagnostic({
        source: `s${i}`,
        message: `msg ${i}`,
        workspace: `/w/${i}`,
      });
    }
    const items = useDiagnostics.getState().items;
    expect(items).toHaveLength(30);
    // newest first
    expect(items[0].source).toBe("s34");
    // first 5 (s0..s4) dropped
    expect(items.some((i) => i.source === "s0")).toBe(false);
  });

  it("extracts message from Error instances in detail", () => {
    reportDiagnostic({
      source: "rag",
      message: "向量检索失败",
      detail: new Error("ECONNREFUSED 127.0.0.1:11434"),
    });
    expect(useDiagnostics.getState().items[0].detail).toBe(
      "ECONNREFUSED 127.0.0.1:11434",
    );
  });

  it("stringifies non-Error details", () => {
    reportDiagnostic({ source: "x", message: "m", detail: { code: 500 } });
    expect(useDiagnostics.getState().items[0].detail).toBe("[object Object]");
    reportDiagnostic({ source: "x2", message: "m", detail: 42 });
    expect(
      useDiagnostics.getState().items.find((i) => i.source === "x2")!.detail,
    ).toBe("42");
  });

  it("does NOT dedupe across different workspaces", () => {
    reportDiagnostic({ source: "workspace", message: "目录加载失败", workspace: "/a" });
    reportDiagnostic({ source: "workspace", message: "目录加载失败", workspace: "/b" });
    expect(useDiagnostics.getState().items).toHaveLength(2);
  });

  it("does NOT dedupe across different sources or messages", () => {
    reportDiagnostic({ source: "rag", message: "失败 A" });
    reportDiagnostic({ source: "rag", message: "失败 B" });
    reportDiagnostic({ source: "sync", message: "失败 A" });
    expect(useDiagnostics.getState().items).toHaveLength(3);
  });

  it("default severity is warning when omitted", () => {
    reportDiagnostic({ source: "x", message: "m" });
    expect(useDiagnostics.getState().items[0].severity).toBe("warning");
  });

  it("all IDs are unique across many rapid reports", () => {
    for (let i = 0; i < 100; i++) {
      reportDiagnostic({ source: `s${i}`, message: `m${i}` });
    }
    const ids = useDiagnostics.getState().items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dedupe re-marks item as unseen so the user sees the fresh failure", () => {
    reportDiagnostic({ source: "rag", message: "索引失败" });
    useDiagnostics.getState().markAllSeen();
    expect(useDiagnostics.getState().items[0].seen).toBe(true);
    reportDiagnostic({ source: "rag", message: "索引失败" });
    expect(useDiagnostics.getState().items[0].seen).toBe(false);
  });
});
