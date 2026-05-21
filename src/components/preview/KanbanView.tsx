import { useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { usePinnedPlan } from "@/stores/pinnedPlan";
import {
  PRIO_COLOR,
  TAG_PALETTE,
  appendTaskToColumn,
  computeProgress,
  parseKanban,
  toggleTaskInSource,
  type Task,
} from "@/lib/kanbanParse";

interface Props {
  body: string;
  source: string;
  /** 当前文件路径，用于钉到所有页面 */
  filePath?: string;
  /** 来自 frontmatter 的元信息 */
  meta?: { title?: string; week?: string; updated?: string };
  onSourceChange?: (next: string) => void;
}

export function KanbanView({ body, source, filePath, meta, onSourceChange }: Props) {
  const columns = useMemo(() => parseKanban(body), [body]);
  const progress = useMemo(() => computeProgress(columns), [columns]);
  const pinnedPath = usePinnedPlan((s) => s.path);
  const togglePin = usePinnedPlan((s) => s.toggle);
  const isPinned = !!filePath && pinnedPath === filePath;

  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const handleToggle = (task: Task) => {
    if (!onSourceChange) return;
    const next = toggleTaskInSource(source, body, task);
    if (next != null) onSourceChange(next);
  };

  const commitAdd = (colTitle: string) => {
    const text = draft.trim();
    setAdding(null);
    setDraft("");
    if (!text || !onSourceChange) return;
    const next = appendTaskToColumn(source, body, colTitle, text);
    if (next != null) onSourceChange(next);
  };

  if (columns.length === 0) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>看板视图为空</h2>
        <p style={{ color: "var(--text-3)" }}>
          在 frontmatter 设 <code>view: kanban</code>，用 <code>#</code> 标题分列，
          子项 <code>- [ ] 文案 #tag !high @05-16 ~2h</code>。
        </p>
      </div>
    );
  }

  const ringDash = 56.5;
  const ringOffset = ringDash * (1 - progress.pct / 100);

  return (
    <div className="preview pl-view">
      <div className="pl-header">
        <div>
          <h1 className="pl-title">{meta?.title ?? "看板"}</h1>
          <div className="pl-meta">
            {meta?.week && <span>{meta.week}</span>}
            {meta?.week && <span className="dot">·</span>}
            <span style={{ color: "var(--accent)" }}>
              {progress.total} 项 · {progress.done} 已完成
            </span>
            {meta?.updated && (
              <>
                <span className="dot">·</span>
                <span>{meta.updated}</span>
              </>
            )}
          </div>
        </div>
        <div className="pl-header-r">
          <div className="pl-progress-mini" title={`完成度 ${progress.pct}%`}>
            <div className="ring">
              <svg viewBox="0 0 24 24" width={28} height={28} aria-hidden>
                <circle cx="12" cy="12" r="9" stroke="var(--border)" strokeWidth="2" fill="none" />
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  fill="none"
                  strokeDasharray={ringDash}
                  strokeDashoffset={ringOffset}
                  strokeLinecap="round"
                  transform="rotate(-90 12 12)"
                />
              </svg>
              <span>{progress.pct}%</span>
            </div>
            <span>完成度</span>
          </div>
          {filePath && (
            <button
              type="button"
              className={"pl-pin-btn" + (isPinned ? " active" : "")}
              onClick={() => togglePin(filePath)}
              title="钉到所有页面右下角"
            >
              <Icon name="pin" size={12} />
              <span>{isPinned ? "已钉选" : "钉到所有页面"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="pl-board">
        {columns.map((col, ci) => {
          const undone = col.tasks.filter((t) => !t.done).length;
          const isAdding = adding === col.title;
          return (
            <div key={ci} className="pl-col">
              <div className="pl-col-h">
                {col.emoji && <span className="ic">{col.emoji}</span>}
                <span className="t">{col.title}</span>
                <span className="n">{undone}</span>
                {onSourceChange && (
                  <button
                    type="button"
                    className="pl-col-add"
                    title="在此列添加任务"
                    onClick={() => {
                      setAdding(col.title);
                      setDraft("");
                    }}
                  >
                    +
                  </button>
                )}
              </div>
              <div className="pl-col-list">
                {col.tasks.map((t, ti) => (
                  <TaskCard key={ti} task={t} onToggle={() => handleToggle(t)} />
                ))}
                {isAdding && onSourceChange && (
                  <div className="pl-task pl-task-draft">
                    <input
                      autoFocus
                      type="text"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitAdd(col.title)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitAdd(col.title);
                        } else if (e.key === "Escape") {
                          setAdding(null);
                          setDraft("");
                        }
                      }}
                      placeholder="任务文案 #tag !high @05-16"
                    />
                  </div>
                )}
                {!isAdding && onSourceChange && (
                  <button
                    type="button"
                    className="pl-quick-add"
                    onClick={() => {
                      setAdding(col.title);
                      setDraft("");
                    }}
                  >
                    + 快速添加
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ task, onToggle }: { task: Task; onToggle: () => void }) {
  const tagStyle = task.tag ? TAG_PALETTE[task.tag.toLowerCase()] : undefined;
  return (
    <div className={"pl-task" + (task.done ? " done" : "")}>
      <div className="pl-task-head">
        <button
          type="button"
          className={"pl-check" + (task.done ? " on" : "")}
          onClick={onToggle}
          aria-label={task.done ? "取消完成" : "标记完成"}
        >
          {task.done && <span>✓</span>}
        </button>
        <div className="pl-task-body">
          <div className="pl-task-title">{task.text}</div>
        </div>
        {task.prio && !task.done && (
          <span
            className="pl-task-prio"
            style={{ background: PRIO_COLOR[task.prio] }}
            title={`优先级: ${task.prio}`}
          />
        )}
      </div>
      {!task.done && (task.tag || task.due || task.est) && (
        <div className="pl-task-meta">
          {task.tag && (
            <span
              className="pl-task-tag"
              style={
                tagStyle
                  ? { background: tagStyle[0], color: tagStyle[1] }
                  : { background: "var(--bg-pane-2)", color: "var(--text-3)" }
              }
            >
              #{task.tag}
            </span>
          )}
          {task.due && <span className="pl-task-due">⏱ {task.due}</span>}
          {task.est && <span className="pl-task-est">{task.est}</span>}
        </div>
      )}
      {typeof task.progress === "number" && !task.done && (
        <div className="pl-task-progress">
          <div style={{ width: `${task.progress}%` }} />
          <span>{task.progress}%</span>
        </div>
      )}
    </div>
  );
}
