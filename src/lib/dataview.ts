// dataview-lite：预览里 ```markio-query 代码块 → 匹配笔记的实时表格。
//
// 复用后端 fs_scan_frontmatter（PropertyExplorer 同款）。纯前端增强：未知围栏被渲染成
// <pre data-lang="markio-query">，这里找到它、解析查询、扫描 frontmatter、渲染表格替换。
//
// 查询语法（逐行 key: value）：
//   key:   要匹配的 frontmatter 字段名（必填）
//   value: 该字段需包含的值（可选；省略则列出所有含该字段的笔记）
//   sort:  name（默认）| value
//   limit: 最多显示条数（可选）

import { api } from "@/lib/api";
import type { NoteFrontmatter } from "@/types";

export interface DataviewQuery {
  key: string;
  value?: string;
  sort: "name" | "value";
  limit?: number;
}

export interface DataviewRow {
  path: string;
  name: string;
  value: string;
}

export function parseDataviewQuery(src: string): DataviewQuery | null {
  const q: Partial<DataviewQuery> = { sort: "name" };
  for (const raw of src.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf(":");
    if (idx < 0) continue;
    const k = t.slice(0, idx).trim().toLowerCase();
    const v = t.slice(idx + 1).trim();
    if (k === "key") q.key = v;
    else if (k === "value") q.value = v || undefined;
    else if (k === "sort") q.sort = v.toLowerCase() === "value" ? "value" : "name";
    else if (k === "limit") {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) q.limit = n;
    }
  }
  if (!q.key) return null;
  return q as DataviewQuery;
}

export function runDataviewQuery(
  notes: NoteFrontmatter[],
  q: DataviewQuery,
): DataviewRow[] {
  const keyLower = q.key.toLowerCase();
  const valLower = q.value?.toLowerCase();
  const rows: DataviewRow[] = [];
  for (const n of notes) {
    const entry = Object.entries(n.fields).find(
      ([k]) => k.toLowerCase() === keyLower,
    );
    if (!entry) continue;
    const values = entry[1];
    if (valLower !== undefined && !values.some((x) => x.toLowerCase() === valLower)) {
      continue;
    }
    rows.push({ path: n.path, name: n.name, value: values.join(", ") });
  }
  rows.sort((a, b) =>
    q.sort === "value"
      ? a.value.localeCompare(b.value) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name),
  );
  return q.limit ? rows.slice(0, q.limit) : rows;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTable(q: DataviewQuery, rows: DataviewRow[]): string {
  const head =
    `<div class="markio-query-head">查询 · ${escapeHtml(q.key)}` +
    (q.value ? ` = ${escapeHtml(q.value)}` : "") +
    ` · ${rows.length} 条</div>`;
  if (rows.length === 0) {
    return `<div class="markio-query-block">${head}<div class="markio-query-empty">没有匹配的笔记</div></div>`;
  }
  const body = rows
    .map(
      (r) =>
        `<tr><td><a class="wikilink" href="#" data-path="${escapeHtml(r.path)}">${escapeHtml(
          r.name,
        )}</a></td><td>${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");
  return (
    `<div class="markio-query-block">${head}` +
    `<table><thead><tr><th>笔记</th><th>${escapeHtml(q.key)}</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

export interface DataviewHandle {
  disconnect(): void;
}

/**
 * 渲染 root 下所有未处理的 ```markio-query 块。需要 workspace 才能扫描 frontmatter。
 * scanFrontmatter 在一次调用内只取一次（多块共享）。
 */
export function renderDataviewBlocks(
  root: HTMLElement,
  workspace: string | undefined,
): DataviewHandle {
  const signal = { cancelled: false };
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('pre[data-lang="markio-query"]'),
  ).filter((el) => !el.dataset.dvRendered);
  if (blocks.length === 0 || !workspace) {
    return { disconnect: () => undefined };
  }

  let notesPromise: Promise<NoteFrontmatter[]> | null = null;
  const loadNotes = () => {
    if (!notesPromise) notesPromise = api.scanFrontmatter(workspace);
    return notesPromise;
  };

  for (const el of blocks) {
    el.dataset.dvRendered = "1";
    const src = el.textContent ?? "";
    const q = parseDataviewQuery(src);
    if (!q) {
      const div = root.ownerDocument.createElement("div");
      div.className = "markio-query-block";
      div.innerHTML =
        '<div class="markio-query-empty">markio-query 缺少 key（至少要写 <code>key: 字段名</code>）</div>';
      el.replaceWith(div);
      continue;
    }
    void (async () => {
      try {
        const notes = await loadNotes();
        if (signal.cancelled || !el.isConnected) return;
        const rows = runDataviewQuery(notes, q);
        const div = root.ownerDocument.createElement("div");
        div.innerHTML = renderTable(q, rows);
        el.replaceWith(div.firstElementChild ?? div);
      } catch {
        if (signal.cancelled || !el.isConnected) return;
        const div = root.ownerDocument.createElement("div");
        div.className = "markio-query-block";
        div.innerHTML = '<div class="markio-query-empty">查询失败</div>';
        el.replaceWith(div);
      }
    })();
  }

  return {
    disconnect: () => {
      signal.cancelled = true;
    },
  };
}
