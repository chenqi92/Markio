import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/Icon";
import { api } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { reportDiagnostic } from "@/stores/diagnostics";
import {
  parseTask,
  compareTasks,
  dueBucket,
  type DueBucket,
  type ParsedTask,
  type TaskPriority,
} from "@/lib/task-parse";

interface TaskItem extends ParsedTask {
  /** workspace id */
  wsId: string;
  /** workspace name (for header chip) */
  wsName: string;
  /** absolute path to source file */
  path: string;
  /** file display name */
  fileName: string;
  /** 1-based line number in source */
  line: number;
}

type GroupMode = "time" | "project" | "priority";

const TIME_BUCKET_ORDER: DueBucket[] = ["overdue", "today", "tomorrow", "thisWeek", "later", "none"];
const PRIORITY_ORDER: Array<TaskPriority | "_"> = ["high", "med", "low", "_"];
const PRIORITY_COLOR: Record<TaskPriority | "_", string> = {
  high: "#dc2626",
  med: "#eab308",
  low: "#22c55e",
  _: "var(--text-4)",
};

/** 跨所有仓库聚合 `- [ ]` 任务；UI 内分组渲染。 */
export function TaskInbox() {
  const { t } = useTranslation();
  const workspaces = useWorkspace((s) => s.workspaces);
  const setActive = useWorkspace((s) => s.setActive);
  const openPath = useTabs((s) => s.openPath);
  const jumpToLine = useUI((s) => s.jumpToLine);

  const [items, setItems] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [groupMode, setGroupMode] = useState<GroupMode>("time");
  const [filter, setFilter] = useState("");

  const bucketLabel = (b: DueBucket) => t(`taskInbox.timeBucket.${b}`);
  const priorityLabel = (k: TaskPriority | "_") =>
    t(`taskInbox.priority.${k === "_" ? "none" : k}`);

  const refresh = async () => {
    if (workspaces.length === 0) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      // 用 fs_grep 直接抓 `- [ ]` 起头行；每个 ws 最多 200 条以免一次返回上千。
      const aggregated: TaskItem[] = [];
      for (const ws of workspaces) {
        try {
          const hits = await api.grep(ws.path, "^[\\s]*[-*+]\\s+\\[\\s+\\]", 200);
          for (const h of hits) {
            const parsed = parseTask(h.preview);
            if (!parsed) continue;
            aggregated.push({
              ...parsed,
              wsId: ws.id,
              wsName: ws.name,
              path: h.path,
              fileName: h.name,
              line: h.line,
            });
          }
        } catch (e) {
          // 单个仓库失败不阻塞其它
          reportDiagnostic({
            source: "task-inbox",
            severity: "warning",
            message: `${ws.name} 任务扫描失败`,
            detail: e,
            workspace: ws.path,
          });
        }
      }
      setItems(aggregated);
    } finally {
      setLoading(false);
    }
  };

  // 首次挂载 + workspaces 变化时刷新；切回 tab 时也手动刷新更直观
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.length]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.text.toLowerCase().includes(q) ||
        it.tags.some((t) => t.toLowerCase().includes(q)) ||
        it.fileName.toLowerCase().includes(q) ||
        it.wsName.toLowerCase().includes(q),
    );
  }, [items, filter]);

  // 分组：返回 [label, color?, items[]] 数组，按预定义顺序排
  const groups = useMemo(() => {
    if (groupMode === "time") {
      const bucketed: Map<DueBucket, TaskItem[]> = new Map();
      for (const it of filtered) {
        const b = dueBucket(it.due);
        const list = bucketed.get(b) ?? [];
        list.push(it);
        bucketed.set(b, list);
      }
      return TIME_BUCKET_ORDER
        .filter((b) => bucketed.has(b))
        .map((b) => ({
          key: b,
          label: bucketLabel(b),
          color: b === "overdue" ? "#dc2626" : b === "today" ? "var(--accent)" : undefined,
          items: (bucketed.get(b) ?? []).sort(compareTasks),
        }));
    }
    if (groupMode === "priority") {
      const bucketed: Map<TaskPriority | "_", TaskItem[]> = new Map();
      for (const it of filtered) {
        const k = it.priority ?? "_";
        const list = bucketed.get(k) ?? [];
        list.push(it);
        bucketed.set(k, list);
      }
      return PRIORITY_ORDER
        .filter((k) => bucketed.has(k))
        .map((k) => ({
          key: k,
          label: priorityLabel(k),
          color: PRIORITY_COLOR[k],
          items: (bucketed.get(k) ?? []).sort(compareTasks),
        }));
    }
    // project = workspace
    const bucketed: Map<string, TaskItem[]> = new Map();
    for (const it of filtered) {
      const list = bucketed.get(it.wsId) ?? [];
      list.push(it);
      bucketed.set(it.wsId, list);
    }
    return Array.from(bucketed.entries()).map(([wsId, list]) => ({
      key: wsId,
      label: list[0]?.wsName ?? wsId,
      color: undefined,
      items: list.sort(compareTasks),
    }));
  }, [filtered, groupMode]);

  const totalCount = items.length;

  const openTaskAt = async (it: TaskItem) => {
    setActive(it.wsId);
    try {
      await openPath(it.path);
      jumpToLine(it.path, it.line);
    } catch (e) {
      reportDiagnostic({
        source: "task-inbox",
        severity: "warning",
        message: "打开任务源失败",
        detail: e,
        workspace: it.path,
      });
    }
  };

  return (
    <div className="task-inbox">
      <div className="ti-h">
        <div className="ti-title">
          {t("taskInbox.title")}
          <span className="ti-count">{totalCount}</span>
        </div>
        <button
          type="button"
          className="ti-refresh"
          title={t("taskInbox.refresh")}
          onClick={() => void refresh()}
          disabled={loading}
        >
          <Icon name="sync" size={12} />
        </button>
      </div>

      <div className="ti-toolbar">
        <input
          type="text"
          className="ti-search"
          placeholder={t("taskInbox.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="ti-groupby" role="group">
          {(["time", "priority", "project"] as const).map((g) => (
            <button
              key={g}
              type="button"
              className={"ti-gb-btn" + (groupMode === g ? " active" : "")}
              onClick={() => setGroupMode(g)}
            >
              {t(`taskInbox.groupBy.${g}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="ti-list">
        {loading && items.length === 0 ? (
          <div className="ti-empty">{t("taskInbox.scanning")}</div>
        ) : groups.length === 0 ? (
          <div className="ti-empty">
            {workspaces.length === 0
              ? t("taskInbox.emptyNoWorkspace")
              : t("taskInbox.emptyNoTasks")}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="ti-group">
              <div className="ti-group-h">
                {g.color && (
                  <span
                    className="ti-group-bar"
                    style={{ background: g.color }}
                  />
                )}
                <span className="ti-group-lbl">{g.label}</span>
                <span className="ti-group-cnt">{g.items.length}</span>
              </div>
              {g.items.map((it, i) => {
                const pColor = PRIORITY_COLOR[it.priority ?? "_"];
                return (
                  <button
                    key={`${it.path}:${it.line}:${i}`}
                    type="button"
                    className="ti-item"
                    onClick={() => void openTaskAt(it)}
                    title={`${it.path}:${it.line}`}
                  >
                    <span
                      className="ti-dot"
                      style={{ background: pColor }}
                      aria-hidden
                    />
                    <div className="ti-item-body">
                      <div className="ti-text">{it.text || t("taskInbox.emptyTaskLabel")}</div>
                      <div className="ti-meta">
                        <span className="ti-src">{it.fileName}</span>
                        {groupMode !== "project" && (
                          <span className="ti-src dim">· {it.wsName}</span>
                        )}
                        {it.due && (
                          <span
                            className={
                              "ti-due " +
                              (dueBucket(it.due) === "overdue" ? "overdue" : "")
                            }
                          >
                            {it.due}
                          </span>
                        )}
                        {it.tags.map((tag) => (
                          <span key={tag} className="ti-tag">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
