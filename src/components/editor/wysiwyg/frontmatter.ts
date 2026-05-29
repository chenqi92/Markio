/**
 * YAML frontmatter 块 widget。
 *
 * 文档开头的 `---\n…\n---` 在 WYSIWYG 下默认渲染成一张只读属性卡片，避免
 * 原始 YAML 字段（title:/tags:/`- 脚本` 等）以裸文本 / 误判列表的形式露出。
 * 点击卡片把光标移进 frontmatter 区间 → build() 的 cursor-aware 逻辑撤掉
 * widget、显形原始文本以便编辑（与代码块 widget 同一套交互）。
 */

import { EditorView, WidgetType } from "@codemirror/view";

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

/** 把含 `---` 分隔符的 frontmatter 源码解析成 [key, value] 行。
 *  只覆盖 `key: value` / `key:` + 缩进 `- item` 列表 / 折叠标量续行三种结构。 */
export function parseFrontmatterRows(src: string): Array<[string, string]> {
  let lines = src.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() === "---") lines = lines.slice(1);
  const closeIdx = lines.findIndex((l) => l.trim() === "---");
  if (closeIdx >= 0) lines = lines.slice(0, closeIdx);

  const rows: Array<{ key: string; vals: string[] }> = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indented = /^[ \t]/.test(line);
    const trimmed = line.replace(/^\s+/, "");

    const li = trimmed.match(/^-\s+(.*)$/);
    if (li && rows.length) {
      rows[rows.length - 1]!.vals.push(unquote(li[1]!));
      continue;
    }
    if (!indented) {
      const idx = trimmed.indexOf(":");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        if (/^[\w-]+$/.test(key)) {
          let val = trimmed.slice(idx + 1).trim();
          if ([">-", ">", "|", "|-", "|+"].includes(val)) val = "";
          rows.push({ key, vals: val ? [unquote(val)] : [] });
          continue;
        }
      }
    }
    if (rows.length) {
      const last = rows[rows.length - 1]!;
      if (!last.vals.length) last.vals.push(trimmed);
      else last.vals[0] = `${last.vals[0]} ${trimmed}`;
    }
  }
  return rows.map((r) => [r.key, r.vals.join(", ")] as [string, string]);
}

export class FrontmatterWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof FrontmatterWidget && other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-frontmatter-widget";
    wrap.title = "点击编辑文档属性";

    const rows = parseFrontmatterRows(this.source);
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-md-frontmatter-empty";
      empty.textContent = "文档属性";
      wrap.append(empty);
    } else {
      const table = document.createElement("table");
      const tbody = document.createElement("tbody");
      for (const [key, value] of rows) {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = key;
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(th, td);
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
    }

    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // frontmatter 始终在文档开头，把光标落到第二行（`---` 之后）即可显形原文编辑
      const pos = Math.min(4, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
