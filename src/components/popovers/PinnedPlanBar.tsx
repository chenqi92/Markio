import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { usePinnedPlan } from "@/stores/pinnedPlan";
import { useTabs } from "@/stores/tabs";
import { api } from "@/lib/api";
import { parseFrontmatter } from "@/lib/frontmatter";
import { computeProgress, parseKanban, type Task } from "@/lib/kanbanParse";

const POLL_MS = 4000;

function basename(p: string): string {
  const last = p.split(/[\\/]/).pop() ?? p;
  return last.replace(/\.md$/i, "");
}

export function PinnedPlanBar() {
  const path = usePinnedPlan((s) => s.path);
  const collapsed = usePinnedPlan((s) => s.collapsed);
  const setCollapsed = usePinnedPlan((s) => s.setCollapsed);
  const unpin = usePinnedPlan((s) => s.unpin);
  const openPath = useTabs((s) => s.openPath);
  const tabs = useTabs((s) => s.tabs);
  const activeTab = useTabs((s) => s.activeTab());

  const [source, setSource] = useState<string>("");
  const [missing, setMissing] = useState(false);

  // 如果钉选的文件在 tabs 中已有，且 dirty content 在内存里，优先读内存
  const liveTab = useMemo(
    () => (path ? tabs.find((t) => t.path === path) : null),
    [tabs, path],
  );

  useEffect(() => {
    if (!path) {
      setSource("");
      setMissing(false);
      return;
    }
    if (liveTab) {
      setSource(liveTab.content);
      setMissing(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const opened = await api.open(path);
        if (cancelled) return;
        setSource(opened.content);
        setMissing(false);
      } catch {
        if (cancelled) return;
        setMissing(true);
        setSource("");
      }
    };
    void load();
    // 文件不在编辑器里时定时轮询
    const handle = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [path, liveTab]);

  const { columns, undone, done, progress } = useMemo(() => {
    const fm = parseFrontmatter(source);
    const cols = parseKanban(fm.body);
    const flat = cols.flatMap((c) => c.tasks);
    return {
      columns: cols,
      undone: flat.filter((t) => !t.done),
      done: flat.filter((t) => t.done),
      progress: computeProgress(cols),
    };
  }, [source]);

  if (!path) return null;
  // 钉选文件正在当前 tab 中显示就不要重复 — 视觉冗余
  if (activeTab?.path === path) return null;

  const title = basename(path);

  const handleOpen = () => {
    void openPath(path);
  };

  if (missing) {
    return (
      <div className="pin-plan-widget collapsed" role="region" aria-label="已钉选的计划">
        <div className="pin-plan-hd">
          <div className="pin-plan-meta">
            <div className="pin-plan-title">
              <span aria-hidden>📌</span>
              <span>{title}</span>
            </div>
            <div className="pin-plan-sub">文件不可读，已暂停同步</div>
          </div>
          <button className="pin-plan-x" onClick={unpin} title="取消钉选" type="button">
            <Icon name="x" size={11} />
          </button>
        </div>
      </div>
    );
  }

  const next = undone[0]?.text;
  const dashLen = 72.3;
  const dashOff = dashLen * (1 - progress.pct / 100);

  return (
    <div
      className={"pin-plan-widget" + (collapsed ? " collapsed" : "")}
      role="region"
      aria-label="已钉选的计划"
    >
      <div
        className="pin-plan-hd"
        onClick={() => setCollapsed(!collapsed)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsed(!collapsed);
          }
        }}
      >
        <div className="pin-plan-progress">
          <svg viewBox="0 0 30 30" width={28} height={28} aria-hidden>
            <circle
              cx="15"
              cy="15"
              r="11.5"
              fill="none"
              stroke="var(--border)"
              strokeWidth="2.5"
            />
            <circle
              cx="15"
              cy="15"
              r="11.5"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2.5"
              strokeDasharray={dashLen}
              strokeDashoffset={dashOff}
              strokeLinecap="round"
              transform="rotate(-90 15 15)"
            />
          </svg>
          <span>{progress.pct}%</span>
        </div>
        <div className="pin-plan-meta">
          <div className="pin-plan-title">
            <span aria-hidden>📌</span>
            <span>{title}</span>
          </div>
          <div className="pin-plan-sub">
            {done.length} / {progress.total} 已完成
            {next ? ` · 下一项：${next}` : progress.total > 0 ? " · 全部完成 🎉" : " · 暂无任务"}
          </div>
        </div>
        <button
          type="button"
          className="pin-plan-collapse"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(!collapsed);
          }}
          title={collapsed ? "展开" : "收起"}
        >
          <span
            style={{
              transform: collapsed ? "rotate(-90deg)" : "none",
              display: "inline-block",
              transition: "transform .2s",
            }}
          >
            ▾
          </span>
        </button>
        <button
          type="button"
          className="pin-plan-x"
          onClick={(e) => {
            e.stopPropagation();
            unpin();
          }}
          title="取消钉选"
        >
          <Icon name="x" size={11} />
        </button>
      </div>
      {!collapsed && (
        <div className="pin-plan-list">
          {columns.length === 0 ? (
            <div className="pin-plan-empty">
              这个文件还没有任务（用 <code>- [ ]</code> 列任务）
            </div>
          ) : (
            <>
              {undone.map((t, i) => (
                <TaskRow key={`u-${i}`} task={t} />
              ))}
              {done.length > 0 && (
                <div className="pin-plan-done-sec">
                  <div className="pin-plan-done-h">已完成 · {done.length}</div>
                  {done.map((t, i) => (
                    <TaskRow key={`d-${i}`} task={t} done />
                  ))}
                </div>
              )}
            </>
          )}
          <div className="pin-plan-foot">
            <button className="pin-plan-open" onClick={handleOpen} type="button">
              打开看板 →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, done }: { task: Task; done?: boolean }) {
  return (
    <div className={"pin-plan-row" + (done ? " done" : "")}>
      <span className={"ck" + (done ? " on" : "")}>{done && "✓"}</span>
      <span className="tx" title={task.text}>
        {task.text}
      </span>
      {task.due && <span className="dt">{task.due}</span>}
      {task.prio === "high" && !done && <span className="prio" aria-hidden />}
    </div>
  );
}
