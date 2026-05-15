import { describe, expect, it } from "vitest";
import { parseWikiLinkBody, resolveWikiFile } from "./wikilinks";
import type { VaultFile } from "@/lib/api";

const files: VaultFile[] = [
  {
    path: "E:/vault/Projects/Roadmap.md",
    name: "Roadmap.md",
    stem: "Roadmap",
    mtime: 0,
    size: 0,
    tags: [],
    mentions: [],
  },
  {
    path: "E:/vault/中文/会议纪要.md",
    name: "会议纪要.md",
    stem: "会议纪要",
    mtime: 0,
    size: 0,
    tags: [],
    mentions: [],
  },
];

describe("wikilinks", () => {
  it("parses aliases and heading fragments", () => {
    expect(parseWikiLinkBody("Roadmap|产品路线")).toEqual({
      target: "Roadmap",
      display: "产品路线",
    });
    expect(parseWikiLinkBody("Roadmap#Q2")).toEqual({
      target: "Roadmap",
      display: "Roadmap#Q2",
      heading: "Q2",
    });
  });

  it("resolves by stem, file name, and nested path", () => {
    expect(resolveWikiFile(files, "roadmap")?.path).toBe("E:/vault/Projects/Roadmap.md");
    expect(resolveWikiFile(files, "Roadmap.md")?.path).toBe("E:/vault/Projects/Roadmap.md");
    expect(resolveWikiFile(files, "中文/会议纪要")?.path).toBe("E:/vault/中文/会议纪要.md");
    expect(resolveWikiFile(files, "missing")).toBeNull();
  });
});
