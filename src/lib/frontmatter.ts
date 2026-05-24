// 极简 frontmatter 解析：只识别开头的 ---\n key: value\n--- 块。
// 不支持嵌套对象 / 数组（够 view 路由用）。

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

export function parseFrontmatter(source: string): Frontmatter {
  if (!source.startsWith("---")) {
    return { data: {}, body: source };
  }
  // 第一行必须是 ---
  const firstNl = source.indexOf("\n");
  if (firstNl < 0) return { data: {}, body: source };
  const head = source.slice(0, firstNl).trim();
  if (head !== "---") return { data: {}, body: source };
  // 找到结束 ---
  const rest = source.slice(firstNl + 1);
  const endMatch = rest.match(/\n---\s*(\n|$)/);
  if (!endMatch || endMatch.index === undefined) {
    return { data: {}, body: source };
  }
  const block = rest.slice(0, endMatch.index);
  const body = rest.slice(endMatch.index + endMatch[0].length);
  const data: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) {
      const [, key, raw] = m;
      data[key!] = raw!.trim().replace(/^["']|["']$/g, "");
    }
  }
  return { data, body };
}
