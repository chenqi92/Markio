import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { NewMenu } from "./NewMenu";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { classNames } from "@/lib/utils";
import { markdownCommands } from "@/lib/markdown-commands";
import type { ViewMode } from "@/types";

const MODES: Array<{ id: ViewMode; label: string; icon: "code" | "split" | "sparkle" | "eye" }> = [
  { id: "source", label: "源码 ⌘1", icon: "code" },
  { id: "split", label: "分屏 ⌘2", icon: "split" },
  { id: "wysiwyg", label: "所见即所得 ⌘3", icon: "sparkle" },
  { id: "preview", label: "阅读 ⌘4", icon: "eye" },
];

export function Toolbar({ onAi, onWechat }: { onAi: () => void; onWechat: () => void }) {
  const mode = useUI((s) => s.mode);
  const setMode = useUI((s) => s.setMode);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const outlineOpen = useUI((s) => s.outlineOpen);
  const focusMode = useUI((s) => s.focusMode);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const toggleOutline = useUI((s) => s.toggleOutline);
  const toggleFocus = useUI((s) => s.toggleFocus);
  const openCommand = useUI((s) => s.openCommand);
  const openFind = useUI((s) => s.openFind);
  const openHistory = useUI((s) => s.openHistory);
  const saveActive = useTabs((s) => s.saveActive);
  const setToast = useUI((s) => s.setToast);
  const dirty = useTabs((s) => s.activeTab()?.dirty ?? false);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const [newOpen, setNewOpen] = useState(false);

  const onSave = async () => {
    if (!dirty) return;
    const outcome = await saveActive();
    if (outcome === "ok") {
      setToast({ stage: "done", message: "已保存" });
      setTimeout(() => setToast(null), 1500);
    } else if (outcome === "conflict") {
      const force = window.confirm(
        "文件已被外部修改。继续保存会覆盖磁盘版本。",
      );
      if (force) {
        const id = useTabs.getState().activeId;
        if (id) await useTabs.getState().saveTab(id, true);
        setToast({ stage: "done", message: "已强制覆盖" });
        setTimeout(() => setToast(null), 1500);
      }
    } else {
      setToast({ stage: "error", message: "保存失败" });
      setTimeout(() => setToast(null), 2000);
    }
  };

  const editable = mode !== "preview";

  return (
    <div className="toolbar-wrap">
      <div className="toolbar">
        <button
          className={classNames("tb-btn", sidebarOpen && "active")}
          title="侧边栏 ⌘⇧L"
          onClick={toggleSidebar}
        >
          <Icon name="sidebar" size={13} />
        </button>

        <div className="tb-sep" />

        <div style={{ position: "relative" }}>
          <button
            ref={newButtonRef}
            className="tb-btn primary"
            title="新建…"
            onClick={() => setNewOpen((v) => !v)}
          >
            <Icon name="plus" size={13} />
            <span>新建</span>
          </button>
          {newOpen && (
            <NewMenu
              anchorRef={newButtonRef}
              onClose={() => setNewOpen(false)}
            />
          )}
        </div>

        <div className="tb-sep" />

        <div className="tb-group">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={classNames("tb-btn", mode === m.id && "active")}
              title={m.label}
              onClick={() => setMode(m.id)}
            >
              <Icon name={m.icon} size={13} />
            </button>
          ))}
        </div>

        <div className="tb-spacer" />

        <button
          className={classNames("tb-btn", focusMode && "active")}
          title="专注模式 ⌘."
          onClick={toggleFocus}
        >
          <Icon name="focus" size={13} />
        </button>
        <button className="tb-btn" title="查找 ⌘F" onClick={() => openFind(true)}>
          <Icon name="search" size={13} />
        </button>
        <button
          className="tb-btn"
          title="保存 ⌘S"
          onClick={onSave}
          disabled={!dirty}
          style={{ opacity: dirty ? 1 : 0.5 }}
        >
          <Icon name="save" size={13} />
        </button>
        <button
          className="tb-btn"
          title="历史 ⌘Y"
          onClick={() => openHistory(true)}
        >
          <Icon name="history" size={13} />
        </button>
        <button
          className="tb-btn"
          title="导出 ⌘E"
          onClick={() => useUI.getState().openExportSheet(true)}
        >
          <Icon name="download" size={13} />
        </button>

        <div className="tb-sep" />

        <button
          type="button"
          className="tb-quick-cap"
          title="快速捕获 ⌥Space"
          onClick={() => useUI.getState().openQuickCapture(true)}
        >
          <span className="bolt" aria-hidden>⚡</span>
          <span>捕获</span>
        </button>

        <button
          type="button"
          className="tb-ai-top"
          title="AI 助手 ⌘J"
          onClick={onAi}
        >
          <span className="orb" aria-hidden>✦</span>
          <span>AI</span>
        </button>

        <div className="tb-divider" aria-hidden />

        <div className="tb-pill" onClick={() => openCommand(true)}>
          <Icon name="cmd" size={11} />
          <span>⌘K</span>
        </div>

        <button
          className="tb-btn tb-wechat"
          title="复制为微信公众号"
          onClick={onWechat}
        >
          微
        </button>

        <button
          className={classNames("tb-btn", outlineOpen && "active")}
          title="大纲 ⌘⇧R"
          onClick={toggleOutline}
        >
          <Icon name="outline" size={13} />
        </button>
      </div>

      {editable && <FormatRow />}
    </div>
  );
}

function FormatRow() {
  const Btn = ({
    title,
    onClick,
    children,
  }: {
    title: string;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      className="tb-btn"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );

  return (
    <div className="toolbar toolbar-row-format">
      <div className="tb-group tb-format">
        <Btn title="一级标题" onClick={markdownCommands.h1}>
          <span className="lvl">H1</span>
        </Btn>
        <Btn title="二级标题" onClick={markdownCommands.h2}>
          <span className="lvl">H2</span>
        </Btn>
        <Btn title="三级标题" onClick={markdownCommands.h3}>
          <span className="lvl">H3</span>
        </Btn>
        <Btn title="四级标题" onClick={markdownCommands.h4}>
          <span className="lvl">H4</span>
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn title="加粗 ⌘B" onClick={markdownCommands.bold}>
          <Icon name="bold" size={12} />
        </Btn>
        <Btn title="斜体 ⌘I" onClick={markdownCommands.italic}>
          <Icon name="italic" size={12} />
        </Btn>
        <Btn title="删除线" onClick={markdownCommands.strike}>
          <Icon name="strike" size={12} />
        </Btn>
        <Btn title="高亮 ⌘⇧H" onClick={markdownCommands.mark}>
          <span
            style={{
              background: "var(--hl-mark)",
              padding: "0 4px",
              borderRadius: 3,
              fontWeight: 700,
              fontSize: 11,
              color: "var(--text)",
            }}
          >
            H
          </span>
        </Btn>
        <Btn title="下划线" onClick={markdownCommands.underline}>
          <Icon name="under" size={12} />
        </Btn>
        <Btn title="行内代码" onClick={markdownCommands.inlineCode}>
          <Icon name="code" size={12} />
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn title="链接" onClick={markdownCommands.link}>
          <Icon name="link" size={12} />
        </Btn>
        <Btn title="双向链接" onClick={markdownCommands.wikiLink}>
          <span
            style={{
              fontSize: 12,
              color: "var(--accent)",
              fontWeight: 700,
              letterSpacing: -1,
            }}
          >
            [[
          </span>
        </Btn>
        <Btn title="图片" onClick={markdownCommands.image}>
          <Icon name="image" size={12} />
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn title="无序列表" onClick={markdownCommands.bulletList}>
          <span style={{ fontSize: 12 }}>•≡</span>
        </Btn>
        <Btn title="有序列表" onClick={markdownCommands.orderedList}>
          <span style={{ fontSize: 11 }}>1.≡</span>
        </Btn>
        <Btn title="待办清单" onClick={markdownCommands.taskList}>
          <Icon name="check-square" size={12} />
        </Btn>
        <Btn title="引用" onClick={markdownCommands.quote}>
          <Icon name="quote" size={12} />
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <TableInsertButton />
        <Btn title="代码块" onClick={markdownCommands.codeBlock}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {"{}"}
          </span>
        </Btn>
        <Btn title="数学公式" onClick={markdownCommands.mathBlock}>
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: 13,
            }}
          >
            ∑
          </span>
        </Btn>
        <Btn title="Mermaid" onClick={markdownCommands.mermaid}>
          <span style={{ fontSize: 12, lineHeight: 1 }}>◇</span>
        </Btn>
        <Btn title="图表 ⌘⌥G" onClick={markdownCommands.chart}>
          <Icon name="chart" size={12} />
        </Btn>
        <Btn title="Graphviz / DOT" onClick={markdownCommands.graphviz}>
          <Icon name="diagram" size={12} />
        </Btn>
        <Btn title="PlantUML" onClick={markdownCommands.plantuml}>
          <span style={{ fontSize: 10, fontWeight: 700 }}>PU</span>
        </Btn>
        <Btn title="提示块" onClick={markdownCommands.callout}>
          <Icon name="info" size={12} />
        </Btn>
        <Btn title="脚注定义" onClick={markdownCommands.footnote}>
          <span style={{ fontSize: 11, fontWeight: 700 }}>[1]</span>
        </Btn>
        <Btn title="分割线" onClick={markdownCommands.horizontalRule}>
          <span style={{ fontSize: 11, letterSpacing: -2 }}>―</span>
        </Btn>
      </div>
    </div>
  );
}

function TableInsertButton() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ rows: 3, cols: 3 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const maxRows = 8;
  const maxCols = 8;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const insert = (rows: number, cols: number) => {
    markdownCommands.insertTable(rows, cols);
    setOpen(false);
  };

  return (
    <div className="tb-popover-host" ref={wrapRef}>
      <button
        type="button"
        className="tb-btn"
        title="表格"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="table" size={12} />
      </button>
      {open && (
        <div
          className="table-size-popover"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="table-size-title">{hover.rows} x {hover.cols}</div>
          <div
            className="table-size-grid"
            style={{
              gridTemplateColumns: `repeat(${maxCols}, 18px)`,
            }}
          >
            {Array.from({ length: maxRows * maxCols }, (_, i) => {
              const row = Math.floor(i / maxCols) + 1;
              const col = (i % maxCols) + 1;
              const active = row <= hover.rows && col <= hover.cols;
              return (
                <button
                  key={`${row}-${col}`}
                  type="button"
                  className={classNames("table-size-cell", active && "active")}
                  aria-label={`插入 ${row} 行 ${col} 列表格`}
                  onMouseEnter={() => setHover({ rows: row, cols: col })}
                  onClick={() => insert(row, col)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
