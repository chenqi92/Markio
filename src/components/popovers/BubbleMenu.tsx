import { Icon } from "../ui/Icon";
import { wrapSelection, selectedText } from "@/lib/editor-bridge";
import { markdownCommands } from "@/lib/markdown-commands";
import { writeText } from "@/lib/clipboard";
import { useUI } from "@/stores/ui";

interface Props {
  x: number;
  y: number;
  onAskAi: () => void;
  onClose: () => void;
}

/**
 * 编辑器选区上方的浮动格式工具栏。
 * 4 组：格式（B/I/U/S）/ 行内（高亮/代码/链接）/ 转块（H1/引用/待办）/ 操作（复制/AI）。
 * 28px 按钮 · 12px 圆角 · 20px 分隔线 · 自下而上 6px 滑入。
 */
export function BubbleMenu({ x, y, onAskAi, onClose }: Props) {
  const setToast = useUI((s) => s.setToast);

  const wrap = (b: string, a?: string) => {
    wrapSelection(b, a ?? b);
    onClose();
  };
  const runBlock = (fn: () => void) => {
    fn();
    onClose();
  };
  const copySelection = async () => {
    const text = selectedText();
    if (!text) {
      onClose();
      return;
    }
    try {
      await writeText(text);
      setToast({ stage: "done", message: "已复制选区" });
      window.setTimeout(() => setToast(null), 1200);
    } catch (e) {
      setToast({ stage: "error", message: `复制失败：${(e as Error).message}` });
      window.setTimeout(() => setToast(null), 2000);
    }
    onClose();
  };

  return (
    <div
      className="bubble"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* 组 1：格式 */}
      <button title="加粗 ⌘B" onClick={() => wrap("**")}>
        <Icon name="bold" size={13} />
      </button>
      <button title="斜体 ⌘I" onClick={() => wrap("*")}>
        <Icon name="italic" size={13} />
      </button>
      <button title="下划线 ⌘U" onClick={() => wrap("<u>", "</u>")}>
        <span style={{ fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>U</span>
      </button>
      <button title="删除线" onClick={() => wrap("~~")}>
        <Icon name="strike" size={13} />
      </button>

      <span className="sep" />

      {/* 组 2：行内装饰 */}
      <button title="高亮" onClick={() => wrap("==")}>
        <span
          style={{
            background: "var(--hl-mark)",
            padding: "0 4px",
            borderRadius: 3,
            fontWeight: 600,
            color: "var(--text)",
            fontSize: 11,
          }}
        >
          H
        </span>
      </button>
      <button title="行内代码 ⌘E" onClick={() => wrap("`")}>
        <Icon name="code" size={13} />
      </button>
      <button
        title="链接 ⌘K"
        onClick={() => {
          markdownCommands.link();
          onClose();
        }}
      >
        <Icon name="link" size={13} />
      </button>

      <span className="sep" />

      {/* 组 3：转换为块 */}
      <button title="转为 H1" onClick={() => runBlock(markdownCommands.h1)}>
        <span style={{ fontSize: 11, fontWeight: 700 }}>H1</span>
      </button>
      <button title="转为引用" onClick={() => runBlock(markdownCommands.quote)}>
        <Icon name="quote" size={13} />
      </button>
      <button title="转为待办" onClick={() => runBlock(markdownCommands.taskList)}>
        <Icon name="check" size={13} />
      </button>

      <span className="sep" />

      {/* 组 4：操作 */}
      <button title="复制选区 ⌘C" onClick={() => void copySelection()}>
        <Icon name="copy" size={13} />
      </button>
      <button
        className="ai-btn"
        title="询问 AI"
        onClick={() => {
          onAskAi();
          onClose();
        }}
      >
        <span className="ai-btn-orb" aria-hidden />
        <span>询问 AI</span>
      </button>
    </div>
  );
}
