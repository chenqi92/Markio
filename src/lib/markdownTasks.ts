export interface MarkdownTaskLine {
  line: number;
  checked: boolean;
}

// 任务项行：必须与渲染器（pulldown-cmark + ENABLE_TASKLISTS）实际产出的复选框
// 一一对应，否则 DOM 第 N 个 checkbox 与源码第 N 个匹配行错位，点击会勾错行。
// 要点：① 跳过代码围栏内的 `- [ ]`（不渲染复选框）；② 兼容有序列表 `1. [ ]` /
// `1) [ ]` 与 blockquote 前缀 `> - [ ]`（这些都会渲染复选框）。
const TASK_LINE_RE = /^(?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
const TASK_TOGGLE_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

export function markdownTaskLines(source: string): MarkdownTaskLine[] {
  const out: MarkdownTaskLine[] = [];
  const lines = source.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const fence = text.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = text.match(TASK_LINE_RE);
    if (m) out.push({ line: i + 1, checked: m[1]!.toLowerCase() === "x" });
  }
  return out;
}

export function toggleMarkdownTaskLine(
  source: string,
  lineNumber: number,
): string | null {
  const lines = source.split(/\r?\n/);
  const line = lines[lineNumber - 1];
  if (line == null) return null;
  const next = line.replace(
    TASK_TOGGLE_RE,
    (_match, before: string, mark: string, after: string) =>
      `${before}${mark.toLowerCase() === "x" ? " " : "x"}${after}`,
  );
  if (next === line) return null;
  lines[lineNumber - 1] = next;
  return lines.join("\n");
}

export function hydrateMarkdownTaskCheckboxes(
  root: ParentNode,
  source: string,
): number {
  const tasks = markdownTaskLines(source);
  let count = 0;
  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(
    (input, index) => {
      const task = tasks[index];
      if (!task) return;
      input.disabled = false;
      input.removeAttribute("disabled");
      input.dataset.sourceLine = String(task.line);
      input.checked = task.checked;
      input.classList.add("md-task-checkbox");
      input.setAttribute("tabindex", "0");
      input.setAttribute(
        "aria-label",
        task.checked ? "标记为未完成" : "标记为完成",
      );
      count++;
    },
  );
  return count;
}
