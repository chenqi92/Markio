import { describe, expect, it } from "vitest";
import { parseDataviewQuery, runDataviewQuery } from "./dataview";
import type { NoteFrontmatter } from "@/types";

const NOTES: NoteFrontmatter[] = [
  { path: "/v/b.md", name: "b.md", fields: { status: ["active"], prio: ["2"] } },
  { path: "/v/a.md", name: "a.md", fields: { status: ["active"], prio: ["1"] } },
  { path: "/v/c.md", name: "c.md", fields: { status: ["done"] } },
  { path: "/v/d.md", name: "d.md", fields: { tag: ["x"] } },
];

describe("parseDataviewQuery", () => {
  it("parses key/value/sort/limit", () => {
    const q = parseDataviewQuery("key: status\nvalue: active\nsort: value\nlimit: 5");
    expect(q).toEqual({ key: "status", value: "active", sort: "value", limit: 5 });
  });
  it("defaults sort to name, ignores comments/blank", () => {
    const q = parseDataviewQuery("# comment\n\nkey: status");
    expect(q).toEqual({ key: "status", sort: "name" });
  });
  it("returns null without a key", () => {
    expect(parseDataviewQuery("value: active")).toBeNull();
  });
});

describe("runDataviewQuery", () => {
  it("filters by key+value and sorts by name", () => {
    const rows = runDataviewQuery(NOTES, { key: "status", value: "active", sort: "name" });
    expect(rows.map((r) => r.name)).toEqual(["a.md", "b.md"]);
  });
  it("lists all notes having the key when no value", () => {
    const rows = runDataviewQuery(NOTES, { key: "status", sort: "name" });
    expect(rows.map((r) => r.name)).toEqual(["a.md", "b.md", "c.md"]);
  });
  it("is case-insensitive on key and value", () => {
    const rows = runDataviewQuery(NOTES, { key: "STATUS", value: "ACTIVE", sort: "name" });
    expect(rows.map((r) => r.name)).toEqual(["a.md", "b.md"]);
  });
  it("respects limit", () => {
    const rows = runDataviewQuery(NOTES, { key: "status", sort: "name", limit: 1 });
    expect(rows).toHaveLength(1);
  });
  it("exposes the matched value column", () => {
    const rows = runDataviewQuery(NOTES, { key: "prio", sort: "value" });
    expect(rows.map((r) => r.value)).toEqual(["1", "2"]);
  });
});
