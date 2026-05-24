import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/types";
import { removeTreePath } from "./workspace";

const dir = (path: string, children: FileEntry[] = []): FileEntry => ({
  name: path.split("/").pop() || path,
  path,
  isDir: true,
  size: 0,
  modified: 0,
  children,
});

const file = (path: string): FileEntry => ({
  name: path.split("/").pop() || path,
  path,
  isDir: false,
  size: 0,
  modified: 0,
});

describe("removeTreePath", () => {
  it("removes a stale child directory without removing its workspace root", () => {
    const root = dir("/vault", [
      file("/vault/00 Welcome.md"),
      dir("/vault/imports", [
        dir("/vault/imports/apple-notes", [file("/vault/imports/apple-notes/a.md")]),
      ]),
    ]);

    const next = removeTreePath(root, "/vault/imports/apple-notes");

    expect(next.path).toBe("/vault");
    expect(next.children?.map((c) => c.path)).toEqual([
      "/vault/00 Welcome.md",
      "/vault/imports",
    ]);
    expect(next.children?.[1]?.children).toEqual([]);
  });

  it("does not remove the root node itself", () => {
    const root = dir("/vault", [file("/vault/a.md")]);
    expect(removeTreePath(root, "/vault")).toBe(root);
  });
});
