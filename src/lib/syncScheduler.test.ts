import { describe, expect, it, vi } from "vitest";
import type { GitStatus } from "./api";
import {
  runSyncWorkflow,
  type SyncWorkflowDeps,
} from "./syncScheduler";

function gitStatus(patch: Partial<GitStatus> = {}): GitStatus {
  return {
    head: "abc1234",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    ...patch,
  };
}

function makeSync() {
  const calls: Array<[string, ...unknown[]]> = [];
  const sync = {
    isInflight: vi.fn(() => false),
    setInflight: vi.fn((workspace: string, value: boolean) => {
      calls.push(["inflight", workspace, value]);
    }),
    setStage: vi.fn((stage: string, summary?: string | null) => {
      calls.push(["stage", stage, summary]);
    }),
    setStatus: vi.fn((status: string, error?: string | null) => {
      calls.push(["status", status, error]);
    }),
    setConflict: vi.fn((files: string[], error: string) => {
      calls.push(["conflict", files, error]);
    }),
    setLastSync: vi.fn((ts: number) => {
      calls.push(["lastSync", ts]);
    }),
  };
  return { sync, calls };
}

function makeDeps(statuses: GitStatus[]): {
  deps: SyncWorkflowDeps;
  calls: Array<[string, ...unknown[]]>;
  gitCalls: string[];
} {
  const { sync, calls } = makeSync();
  const queue = [...statuses];
  let last = statuses[statuses.length - 1] ?? gitStatus();
  const gitCalls: string[] = [];
  const deps: SyncWorkflowDeps = {
    gitStatus: vi.fn(async () => {
      gitCalls.push("status");
      last = queue.shift() ?? last;
      return last;
    }),
    gitFetch: vi.fn(async () => {
      gitCalls.push("fetch");
    }),
    gitCommit: vi.fn(async () => {
      gitCalls.push("commit");
      return "def5678";
    }),
    gitPull: vi.fn(async () => {
      gitCalls.push("pull");
    }),
    gitPush: vi.fn(async () => {
      gitCalls.push("push");
    }),
    sync: () => sync,
    settings: () => ({ syncConflictStrategy: "ask" }),
    report: vi.fn(),
    now: () => new Date("2026-05-20T00:00:00.000Z"),
    online: () => true,
  };
  return { deps, calls, gitCalls };
}

describe("runSyncWorkflow", () => {
  it("snapshots local changes, fetches remote state, pulls, then pushes", async () => {
    const { deps, calls, gitCalls } = makeDeps([
      gitStatus({ files: [{ path: "a.md", kind: "modified" }] }),
      gitStatus({ ahead: 1 }),
      gitStatus({ ahead: 1, behind: 1 }),
      gitStatus({ ahead: 2 }),
      gitStatus(),
    ]);

    await runSyncWorkflow("/repo", deps);

    expect(gitCalls).toEqual([
      "status",
      "commit",
      "status",
      "fetch",
      "status",
      "pull",
      "status",
      "push",
      "status",
    ]);
    expect(calls.filter((c) => c[0] === "stage").map((c) => c[1])).toEqual([
      "preflight",
      "snapshot",
      "fetch",
      "pull",
      "push",
      "done",
    ]);
    expect(calls).toContainEqual(["lastSync", Date.parse("2026-05-20T00:00:00.000Z")]);
  });

  it("skips clean repositories without upstream instead of inventing a push target", async () => {
    const { deps, calls, gitCalls } = makeDeps([
      gitStatus({ upstream: undefined }),
    ]);

    await runSyncWorkflow("/repo", deps);

    expect(gitCalls).toEqual(["status"]);
    expect(calls).toContainEqual([
      "stage",
      "idle",
      "当前分支没有 upstream，跳过同步",
    ]);
  });

  it("records pull conflicts without continuing to push", async () => {
    const { deps, calls, gitCalls } = makeDeps([
      gitStatus(),
      gitStatus({ behind: 1 }),
    ]);
    deps.gitPull = vi.fn(async () => {
      gitCalls.push("pull");
      throw new Error("CONFLICT:a.md\ndocs/b.md");
    });

    await runSyncWorkflow("/repo", deps);

    expect(gitCalls).toEqual(["status", "fetch", "status", "pull"]);
    expect(calls).toContainEqual([
      "conflict",
      ["a.md", "docs/b.md"],
      "git pull 失败：CONFLICT:a.md\ndocs/b.md",
    ]);
    expect(deps.gitPush).not.toHaveBeenCalled();
  });
});
