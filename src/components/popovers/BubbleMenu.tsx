import { Icon } from "../ui/Icon";
import { wrapSelection } from "@/lib/editor-bridge";

interface Props {
  x: number;
  y: number;
  onAskAi: () => void;
  onClose: () => void;
}

/** 编辑器选区上方的浮动格式工具栏 */
export function BubbleMenu({ x, y, onAskAi, onClose }: Props) {
  const wrap = (b: string, a?: string) => {
    wrapSelection(b, a ?? b);
    onClose();
  };
  return (
    <div className="bubble" style={{ left: x, top: y }}>
      <button title="加粗 ⌘B" onClick={() => wrap("**")}>
        <Icon name="bold" size={13} />
      </button>
      <button title="斜体 ⌘I" onClick={() => wrap("*")}>
        <Icon name="italic" size={13} />
      </button>
      <button title="删除线" onClick={() => wrap("~~")}>
        <Icon name="strike" size={13} />
      </button>
      <span className="sep" />
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
      <button title="行内代码" onClick={() => wrap("`")}>
        <Icon name="code" size={13} />
      </button>
      <button
        title="链接"
        onClick={() => {
          const url = window.prompt("链接 URL", "https://");
          if (!url) return;
          wrapSelection("[", `](${url})`);
          onClose();
        }}
      >
        <Icon name="link" size={13} />
      </button>
      <span className="sep" />
      <button
        className="ai-btn"
        title="询问 AI"
        onClick={() => {
          onAskAi();
          onClose();
        }}
      >
        <Icon name="sparkle" size={11} />
        <span style={{ marginLeft: 4 }}>询问 AI</span>
      </button>
    </div>
  );
}
