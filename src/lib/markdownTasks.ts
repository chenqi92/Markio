export interface MarkdownTaskLine {
  line: number;
  checked: boolean;
}

export function markdownTaskLines(source: string): MarkdownTaskLine[] {
  return source.split(/\r?\n/).reduce<MarkdownTaskLine[]>((out, text, index) => {
    const m = text.match(/^\s*[-*+]\s+\[([ xX])\]/);
    if (m) out.push({ line: index + 1, checked: m[1].toLowerCase() === "x" });
    return out;
  }, []);
}

export function toggleMarkdownTaskLine(
  source: string,
  lineNumber: number,
): string | null {
  const lines = source.split(/\r?\n/);
  const line = lines[lineNumber - 1];
  if (line == null) return null;
  const next = line.replace(
    /^(\s*[-*+]\s+\[)([ xX])(\])/,
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
