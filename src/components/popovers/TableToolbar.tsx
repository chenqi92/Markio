import { Icon } from "../ui/Icon";
import { applyTableAction, type TableAction } from "../editor/table-edit";
import { getEditor } from "@/lib/editor-bridge";

interface Props {
  x: number;
  y: number;
  align: "left" | "center" | "right" | null;
}

export function TableToolbar({ x, y, align }: Props) {
  const run = (action: TableAction) => {
    const view = getEditor();
    if (!view) return;
    applyTableAction(view, action);
    view.focus();
  };
  return (
    <div
      className="table-toolbar"
      style={{
        position: "fixed",
        left: x,
        top: y,
        display: "inline-flex",
        gap: 2,
        background: "var(--bg-pane)",
        border: "0.5px solid var(--border)",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
        zIndex: 90,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <ToolBtn title="上方插入行" onClick={() => run({ type: "insertRowAbove" })}>
        ↑+
      </ToolBtn>
      <ToolBtn title="下方插入行" onClick={() => run({ type: "insertRowBelow" })}>
        ↓+
      </ToolBtn>
      <ToolBtn title="左侧插入列" onClick={() => run({ type: "insertColLeft" })}>
        ←+
      </ToolBtn>
      <ToolBtn title="右侧插入列" onClick={() => run({ type: "insertColRight" })}>
        +→
      </ToolBtn>
      <span style={{ width: 1, background: "var(--border)" }} />
      <ToolBtn title="删除当前行" onClick={() => run({ type: "deleteRow" })}>
        <Icon name="trash" size={12} />
      </ToolBtn>
      <ToolBtn title="删除当前列" onClick={() => run({ type: "deleteCol" })}>
        ⨯|
      </ToolBtn>
      <span style={{ width: 1, background: "var(--border)" }} />
      <ToolBtn
        title="左对齐"
        active={align === "left"}
        onClick={() => run({ type: "align", value: "left" })}
      >
        ⇤
      </ToolBtn>
      <ToolBtn
        title="居中对齐"
        active={align === "center"}
        onClick={() => run({ type: "align", value: "center" })}
      >
        ⇔
      </ToolBtn>
      <ToolBtn
        title="右对齐"
        active={align === "right"}
        onClick={() => run({ type: "align", value: "right" })}
      >
        ⇥
      </ToolBtn>
    </div>
  );
}

function ToolBtn({
  children,
  title,
  active,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        minWidth: 24,
        height: 24,
        padding: "0 6px",
        border: 0,
        borderRadius: 6,
        cursor: "pointer",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--text)",
        fontSize: 11,
        fontFamily:
          "var(--font-sans, -apple-system, 'PingFang SC', sans-serif)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}
