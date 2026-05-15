import { Icon } from "../ui/Icon";
import {
  applyTableAction,
  tableClipboardText,
  type TableAction,
  type TableClipboardMode,
} from "../editor/table-edit";
import { getEditor } from "@/lib/editor-bridge";
import { writeText } from "@/lib/clipboard";

interface Props {
  x: number;
  y: number;
  align: "left" | "center" | "right" | null;
  row: number;
  col: number;
  rows: number;
  cols: number;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function TableToolbar({
  x,
  y,
  align,
  row,
  col,
  rows,
  cols,
  onMouseEnter,
  onMouseLeave,
}: Props) {
  // x is treated as the horizontal CENTER of the toolbar (CSS uses
  // translateX(-50%)). Clamp center so the toolbar can never poke outside
  // the viewport assuming worst-case ~920px width.
  const left =
    typeof window === "undefined"
      ? x
      : (() => {
          const half = Math.min(460, Math.floor((window.innerWidth - 16) / 2));
          return Math.max(half + 8, Math.min(x, window.innerWidth - half - 8));
        })();
  const top =
    typeof window === "undefined"
      ? y
      : Math.max(8, Math.min(y, window.innerHeight - 48));
  const run = (action: TableAction) => {
    const view = getEditor();
    if (!view) return;
    applyTableAction(view, action);
    view.focus();
  };
  const copy = async (mode: TableClipboardMode) => {
    const view = getEditor();
    if (!view) return;
    const text = tableClipboardText(view, mode);
    if (text == null) return;
    await writeText(text);
    view.focus();
  };
  return (
    <div
      className="table-toolbar"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="table-toolbar-status">
        {rows}x{cols} · R{row + 1} C{col + 1}
      </div>
      <div className="table-toolbar-group">
        <ToolBtn title="选中当前单元格" onClick={() => run({ type: "selectCell" })}>
          单元
        </ToolBtn>
        <ToolBtn title="选中整张表格" onClick={() => run({ type: "selectTable" })}>
          全表
        </ToolBtn>
        <ToolBtn title="按列宽整理 Markdown 表格" onClick={() => run({ type: "format" })}>
          整理
        </ToolBtn>
      </div>
      <div className="table-toolbar-group">
        <ToolBtn title="上方插入行" onClick={() => run({ type: "insertRowAbove" })}>
          行↑+
        </ToolBtn>
        <ToolBtn title="下方插入行" onClick={() => run({ type: "insertRowBelow" })}>
          行↓+
        </ToolBtn>
        <ToolBtn title="复制当前行到下方" onClick={() => run({ type: "duplicateRow" })}>
          行×2
        </ToolBtn>
        <ToolBtn title="上移当前行" onClick={() => run({ type: "moveRowUp" })}>
          行↑
        </ToolBtn>
        <ToolBtn title="下移当前行" onClick={() => run({ type: "moveRowDown" })}>
          行↓
        </ToolBtn>
        <ToolBtn title="左侧插入列" onClick={() => run({ type: "insertColLeft" })}>
          列←+
        </ToolBtn>
        <ToolBtn title="右侧插入列" onClick={() => run({ type: "insertColRight" })}>
          列+→
        </ToolBtn>
        <ToolBtn title="复制当前列到右侧" onClick={() => run({ type: "duplicateCol" })}>
          列×2
        </ToolBtn>
        <ToolBtn title="左移当前列" onClick={() => run({ type: "moveColLeft" })}>
          列←
        </ToolBtn>
        <ToolBtn title="右移当前列" onClick={() => run({ type: "moveColRight" })}>
          列→
        </ToolBtn>
      </div>
      <div className="table-toolbar-group">
        <ToolBtn title="复制单元格" onClick={() => void copy("cell")}>
          <Icon name="copy" size={12} />
          单元
        </ToolBtn>
        <ToolBtn title="复制当前行为制表符数据" onClick={() => void copy("row")}>
          <Icon name="copy" size={12} />
          行
        </ToolBtn>
        <ToolBtn title="复制当前列为制表符数据" onClick={() => void copy("col")}>
          <Icon name="copy" size={12} />
          列
        </ToolBtn>
        <ToolBtn title="复制整张表为制表符数据" onClick={() => void copy("table")}>
          <Icon name="copy" size={12} />
          表
        </ToolBtn>
      </div>
      <div className="table-toolbar-group">
        <ToolBtn title="清空当前单元格" onClick={() => run({ type: "clearCell" })}>
          清单元
        </ToolBtn>
        <ToolBtn title="向下填充当前单元格" onClick={() => run({ type: "fillDown" })}>
          向下填
        </ToolBtn>
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
        <ToolBtn title="按当前列升序排序" onClick={() => run({ type: "sortAsc" })}>
          A↑
        </ToolBtn>
        <ToolBtn title="按当前列降序排序" onClick={() => run({ type: "sortDesc" })}>
          Z↓
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
