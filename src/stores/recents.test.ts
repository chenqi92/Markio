import { beforeEach, describe, expect, it } from "vitest";
import { sanitizeRecentItems, useRecents } from "./recents";

function reset() {
  useRecents.setState({ items: [] });
}

describe("recents store path maintenance", () => {
  beforeEach(reset);

  it("forgetUnder removes the file and everything under a folder", () => {
    const { push, forgetUnder } = useRecents.getState();
    push("ws", "/repo/a.md", "a.md");
    push("ws", "/repo/dir/b.md", "b.md");
    push("ws", "/repo/dir/sub/c.md", "c.md");
    push("ws", "/repo/other.md", "other.md");

    forgetUnder("/repo/dir");
    const paths = useRecents.getState().items.map((it) => it.path);
    expect(paths).toEqual(["/repo/other.md", "/repo/a.md"]);
  });

  it("forgetUnder treats a single file path as itself", () => {
    const { push, forgetUnder } = useRecents.getState();
    push("ws", "/repo/a.md", "a.md");
    push("ws", "/repo/ab.md", "ab.md"); // 不能因为前缀 a 误删
    forgetUnder("/repo/a.md");
    const paths = useRecents.getState().items.map((it) => it.path);
    expect(paths).toEqual(["/repo/ab.md"]);
  });

  it("relocate rewrites old path prefix and refreshes name", () => {
    const { push, relocate } = useRecents.getState();
    push("ws", "/repo/dir/b.md", "b.md");
    push("ws", "/repo/dir/sub/c.md", "c.md");
    push("ws", "/repo/keep.md", "keep.md");

    relocate("/repo/dir", "/repo/renamed");
    const items = useRecents.getState().items;
    const byOldName = Object.fromEntries(items.map((it) => [it.name, it.path]));
    expect(byOldName["b.md"]).toBe("/repo/renamed/b.md");
    expect(byOldName["c.md"]).toBe("/repo/renamed/sub/c.md");
    expect(byOldName["keep.md"]).toBe("/repo/keep.md");
  });

  it("relocate of a single file updates its name", () => {
    const { push, relocate } = useRecents.getState();
    push("ws", "/repo/old.md", "old.md");
    relocate("/repo/old.md", "/repo/new.md");
    const [item] = useRecents.getState().items;
    expect(item!.path).toBe("/repo/new.md");
    expect(item!.name).toBe("new.md");
  });

  it("normalizes backslash paths when matching", () => {
    const { push, forgetUnder } = useRecents.getState();
    push("ws", "C:/repo/dir/b.md", "b.md");
    forgetUnder("C:\\repo\\dir");
    expect(useRecents.getState().items).toHaveLength(0);
  });
});

describe("sanitizeRecentItems (corrupt store guard)", () => {
  it("returns empty for non-array input", () => {
    expect(sanitizeRecentItems(undefined)).toEqual([]);
    expect(sanitizeRecentItems(null)).toEqual([]);
    expect(sanitizeRecentItems("nope")).toEqual([]);
    expect(sanitizeRecentItems({ items: [] })).toEqual([]);
  });

  it("drops entries with missing or wrong-typed fields", () => {
    const good = { workspaceId: "ws", path: "/a.md", name: "a.md", at: 1 };
    const items = sanitizeRecentItems([
      good,
      null,
      { path: "/b.md", name: "b.md", at: 2 }, // 缺 workspaceId
      { workspaceId: "ws", path: 123, name: "c", at: 3 }, // path 非字符串
      { workspaceId: "ws", path: "/d.md", name: "d.md", at: "x" }, // at 非数字
      "string-entry",
    ]);
    expect(items).toEqual([good]);
  });
});
