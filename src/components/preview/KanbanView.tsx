import { useMemo } from "react";

interface Task {
  raw: string;
  /** 在原 source 中的行号 (0-based)，用于回写 checkbox */
  lineIndex: number;
  text: string;
  done: boolean;
  tag?: string;
}

interface Column {
  title: string;
  tasks: Task[];
}

/** 从 markdown body 解析 # Heading + 子任务 (- [ ]/-[x])。 */
function parseColumns(body: string): Column[] {
  const lines = body.split("\n");
  const cols: Column[] = [];
  let current: Column | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const hMatch = ln.match(/^#{1,3}\s+(.+?)\s*$/);
    if (hMatch) {
      current = { title: hMatch[1].trim(), tasks: [] };
      cols.push(current);
      continue;
    }
    const tMatch = ln.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (tMatch && current) {
      const done = tMatch[1].toLowerCase() === "x";
      let text = tMatch[2];
      let tag: string | undefined;
      const tagMatch = text.match(/#([\p{L}\p{N}_-]+)/u);
      if (tagMatch) tag = tagMatch[1];
      current.tasks.push({
        raw: ln,
        lineIndex: i,
        text,
        done,
        tag,
      });
    }
  }
  return cols;
}

interface Props {
  body: string;
  source: string;
  onSourceChange?: (next: string) => void;
}

export function KanbanView({ body, source, onSourceChange }: Props) {
  const columns = useMemo(() => parseColumns(body), [body]);

  const toggleTask = (task: Task) => {
    if (!onSourceChange) return;
    // body 在 source 中的偏移
    const bodyOffset = source.length - body.length;
    const lines = source.split("\n");
    // body 的第 task.lineIndex 行对应 source 中的哪行
    const linesBefore = source.slice(0, bodyOffset).split("\n").length - 1;
    const idx = linesBefore + task.lineIndex;
    if (idx < 0 || idx >= lines.length) return;
    const oldLine = lines[idx];
    if (!oldLine.includes("[ ]") && !/\[[xX]\]/.test(oldLine)) return;
    const replaced = task.done
      ? oldLine.replace(/\[[xX]\]/, "[ ]")
      : oldLine.replace("[ ]", "[x]");
    if (replaced === oldLine) return;
    lines[idx] = replaced;
    onSourceChange(lines.join("\n"));
  };

  const totalDone = columns.reduce(
    (acc, c) => acc + c.tasks.filter((t) => t.done).length,
    0,
  );
  const totalTasks = columns.reduce((acc, c) => acc + c.tasks.length, 0);

  if (columns.length === 0) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>看板视图为空</h2>
        <p style={{ color: "var(--text-3)" }}>
          在 frontmatter 设 <code>view: kanban</code>，然后用 <code>#</code>{" "}
          / <code>##</code> 标题分列，子项用 <code>- [ ]</code> / <code>- [x]</code> 标记。
        </p>
      </div>
    );
  }

  return (
    <div
      className="preview kanban-view"
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          看板视图 · {totalDone} / {totalTasks} 已完成
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: `repeat(${columns.length}, minmax(220px, 1fr))`,
          gap: 12,
          overflow: "auto",
        }}
      >
        {columns.map((col, ci) => (
          <div
            key={ci}
            style={{
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minHeight: 100,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingBottom: 6,
                borderBottom: "1px solid var(--border)",
                fontWeight: 600,
              }}
            >
              <span style={{ flex: 1 }}>{col.title}</span>
              <span style={{ color: "var(--text-3)", fontSize: 11 }}>
                {col.tasks.filter((t) => !t.done).length} / {col.tasks.length}
              </span>
            </div>
            {col.tasks.length === 0 ? (
              <div style={{ color: "var(--text-3)", fontSize: 12 }}>
                — 空 —
              </div>
            ) : (
              col.tasks.map((t, ti) => (
                <label
                  key={ti}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    padding: "6px 8px",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    cursor: onSourceChange ? "pointer" : "default",
                    opacity: t.done ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={() => toggleTask(t)}
                    disabled={!onSourceChange}
                    style={{ marginTop: 2 }}
                  />
                  <span
                    style={{
                      flex: 1,
                      textDecoration: t.done ? "line-through" : "none",
                      fontSize: 13,
                      lineHeight: 1.45,
                    }}
                  >
                    {t.text}
                  </span>
                  {t.tag && (
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--accent)",
                        background: "var(--accent-glow, rgba(10,132,255,0.12))",
                        padding: "1px 6px",
                        borderRadius: 999,
                      }}
                    >
                      #{t.tag}
                    </span>
                  )}
                </label>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
