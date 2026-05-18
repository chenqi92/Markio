import { beforeEach, describe, expect, it } from "vitest";
import { useSync } from "./sync";

beforeEach(() => {
  useSync.setState({
    status: "idle",
    stage: "idle",
    lastSyncAt: null,
    lastError: null,
    lastSummary: null,
    conflictFiles: [],
    inflight: {},
  });
});

describe("sync store", () => {
  it("tracks active sync stages", () => {
    useSync.getState().setStage("preflight", "检查 Git 状态");
    expect(useSync.getState().status).toBe("syncing");
    expect(useSync.getState().stage).toBe("preflight");
    expect(useSync.getState().lastSummary).toBe("检查 Git 状态");

    useSync.getState().setStage("pull", "拉取远端变更");
    expect(useSync.getState().status).toBe("syncing");
    expect(useSync.getState().stage).toBe("pull");
    expect(useSync.getState().lastError).toBeNull();
  });

  it("records conflict files", () => {
    useSync.getState().setConflict(["a.md", "docs/b.md"], "CONFLICT:a.md\ndocs/b.md");
    const state = useSync.getState();
    expect(state.status).toBe("error");
    expect(state.stage).toBe("conflict");
    expect(state.conflictFiles).toEqual(["a.md", "docs/b.md"]);
    expect(state.lastSummary).toContain("2 个文件");
  });

  it("clears conflict files when a new sync stage starts", () => {
    useSync.getState().setConflict(["a.md"], "CONFLICT:a.md");
    useSync.getState().setStage("preflight", "检查 Git 状态");
    const state = useSync.getState();
    expect(state.status).toBe("syncing");
    expect(state.stage).toBe("preflight");
    expect(state.conflictFiles).toEqual([]);
    expect(state.lastError).toBeNull();
  });
});
