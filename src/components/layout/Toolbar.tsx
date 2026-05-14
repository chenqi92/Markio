import { useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { NewMenu } from "./NewMenu";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { classNames } from "@/lib/utils";
import { insertBlock, prefixLine, wrapSelection } from "@/lib/editor-bridge";
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
    <button type="button" className="tb-btn" title={title} onClick={onClick}>
      {children}
    </button>
  );

  return (
    <div className="toolbar toolbar-row-format">
      <div className="tb-group tb-format">
        <Btn title="一级标题" onClick={() => prefixLine("# ")}>
          <span className="lvl">H1</span>
        </Btn>
        <Btn title="二级标题" onClick={() => prefixLine("## ")}>
          <span className="lvl">H2</span>
        </Btn>
        <Btn title="三级标题" onClick={() => prefixLine("### ")}>
          <span className="lvl">H3</span>
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn title="加粗 ⌘B" onClick={() => wrapSelection("**", "**", "加粗文字")}>
          <Icon name="bold" size={12} />
        </Btn>
        <Btn title="斜体 ⌘I" onClick={() => wrapSelection("*", "*", "斜体")}>
          <Icon name="italic" size={12} />
        </Btn>
        <Btn title="删除线" onClick={() => wrapSelection("~~", "~~", "删除")}>
          <Icon name="strike" size={12} />
        </Btn>
        <Btn title="高亮 ⌘⇧H" onClick={() => wrapSelection("==", "==", "高亮")}>
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
        <Btn title="行内代码" onClick={() => wrapSelection("`", "`", "code")}>
          <Icon name="code" size={12} />
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn
          title="链接"
          onClick={() => {
            const url = window.prompt("链接 URL", "https://");
            if (!url) return;
            wrapSelection("[", `](${url})`, "链接文本");
          }}
        >
          <Icon name="link" size={12} />
        </Btn>
        <Btn title="双向链接" onClick={() => wrapSelection("[[", "]]", "笔记名")}>
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
        <Btn
          title="图片"
          onClick={() => {
            const url = window.prompt("图片 URL", "https://");
            if (!url) return;
            wrapSelection("![", `](${url})`, "alt");
          }}
        >
          <Icon name="image" size={12} />
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn title="无序列表" onClick={() => prefixLine("- ")}>
          <span style={{ fontSize: 12 }}>•≡</span>
        </Btn>
        <Btn title="有序列表" onClick={() => prefixLine("1. ")}>
          <span style={{ fontSize: 11 }}>1.≡</span>
        </Btn>
        <Btn title="待办清单" onClick={() => prefixLine("- [ ] ")}>
          <Icon name="check-square" size={12} />
        </Btn>
        <Btn title="引用" onClick={() => prefixLine("> ")}>
          <Icon name="quote" size={12} />
        </Btn>
      </div>
      <div className="tb-group tb-format">
        <Btn
          title="表格"
          onClick={() =>
            insertBlock(
              "\n| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n| | | |\n",
              { atLineStart: true },
            )
          }
        >
          <Icon name="table" size={12} />
        </Btn>
        <Btn
          title="代码块"
          onClick={() =>
            insertBlock("\n```ts\n\n```\n", { atLineStart: true })
          }
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
            {"{}"}
          </span>
        </Btn>
        <Btn
          title="数学公式"
          onClick={() => insertBlock("\n$$\n\n$$\n", { atLineStart: true })}
        >
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
        <Btn
          title="Mermaid"
          onClick={() =>
            insertBlock("\n```mermaid\ngraph LR\n  A --> B\n```\n", {
              atLineStart: true,
            })
          }
        >
          <span style={{ fontSize: 12, lineHeight: 1 }}>◇</span>
        </Btn>
        <Btn title="分割线" onClick={() => insertBlock("\n---\n", { atLineStart: true })}>
          <span style={{ fontSize: 11, letterSpacing: -2 }}>―</span>
        </Btn>
      </div>
    </div>
  );
}
