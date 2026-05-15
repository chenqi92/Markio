import { Icon } from "../ui/Icon";
import { applyTableAction, type TableAction } from "../editor/table-edit";
import { getEditor } from "@/lib/editor-bridge";

interface Props {
  x: number;
  y: number;
  align: "left" | "center" | "right" | null;
}

export function TableToolbar({ x, y, align }: Props) {
  const left =
    typeof window === "undefined"
      ? x
      : Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 760));
  const top =
    typeof window === "undefined"
      ? y
      : Math.max(8, Math.min(y, window.innerHeight - 42));
  const run = (action: TableAction) => {
    const view = getEditor();
    if (!view) return;
    applyTableAction(view, action);
    view.focus();
  };
  return (
    <div
      className="table-toolbar"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="table-toolbar-group">
        <ToolBtn title="上方插入行" onClick={() => run({ type: "insertRowAbove" })}>
          行↑+
        </ToolBtn>
        <ToolBtn title="下方插入行" onClick={() => run({ type: "insertRowBelow" })}>
          行↓+
        </ToolBtn>
        <ToolBtn title="左侧插入列" onClick={() => run({ type: "insertColLeft" })}>
          列←+
        </ToolBtn>
        <ToolBtn title="右侧插入列" onClick={() => run({ type: "insertColRight" })}>
          列+→
        </ToolBtn>
      </div>
      <div className="table-toolbar-group">
        <ToolBtn title="选中当前行" onClick={() => run({ type: "selectRow" })}>
          选行
        </ToolBtn>
        <ToolBtn title="选中当前列" onClick={() => run({ type: "selectCol" })}>
          选列
        </ToolBtn>
        <ToolBtn title="清空当前行" onClick={() => run({ type: "clearRow" })}>
          清行
        </ToolBtn>
        <ToolBtn title="清空当前列" onClick={() => run({ type: "clearCol" })}>
          清列
        </ToolBtn>
      </div>
      <div className="table-toolbar-group">
        <ToolBtn title="删除当前行" onClick={() => run({ type: "deleteRow" })}>
          <Icon name="trash" size={12} />
          行
        </ToolBtn>
        <ToolBtn title="删除当前列" onClick={() => run({ type: "deleteCol" })}>
          <Icon name="trash" size={12} />
          列
        </ToolBtn>
      </div>
      <div className="table-toolbar-group">
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
      className="table-toolbar-btn"
      title={title}
      onClick={onClick}
      data-active={active ? "true" : undefined}
    >
      {children}
    </button>
  );
}
