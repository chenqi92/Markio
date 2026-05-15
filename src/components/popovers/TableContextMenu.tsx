import { useEffect } from "react";
import { Icon } from "../ui/Icon";
import {
  applyTableAction,
  clearTableRect,
  pasteTableText,
  tableRectClipboardText,
  type TableAction,
  type TableSelectionRect,
} from "../editor/table-edit";
import { getEditor } from "@/lib/editor-bridge";
import { readText, writeText } from "@/lib/clipboard";

interface Props {
  x: number;
  y: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
  rect: TableSelectionRect | null;
  onClose: () => void;
}

export function TableContextMenu({ x, y, row, col, rows, cols, rect, onClose }: Props) {
  const left =
    typeof window === "undefined"
      ? x
      : Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 250));
  const top =
    typeof window === "undefined"
      ? y
      : Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 330));
  const selectedRows = rect ? rect.endRow - rect.startRow + 1 : 1;
  const selectedCols = rect ? rect.endCol - rect.startCol + 1 : 1;
  const selectionLabel =
    selectedRows > 1 || selectedCols > 1
      ? `${selectedRows}x${selectedCols} 选区`
      : `R${row + 1} C${col + 1}`;

  useEffect(() => {
    const closeOnOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".table-context-menu")) onClose();
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", closeOnOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  const focus = () => getEditor()?.focus();

  const run = (action: TableAction) => {
    const view = getEditor();
    if (!view) return;
    applyTableAction(view, action);
    focus();
    onClose();
  };

  const copySelection = async () => {
    const view = getEditor();
    if (!view || !rect) return;
    const text = tableRectClipboardText(view, rect);
    if (text == null) return;
    await writeText(text);
    focus();
    onClose();
  };

  const pasteSelection = async () => {
    const view = getEditor();
    if (!view) return;
    const text = await readText();
    if (!text) return;
    pasteTableText(
      view,
      text,
      rect ? { row: rect.startRow, col: rect.startCol } : { row, col },
    );
    focus();
    onClose();
  };

  const clearSelection = () => {
    const view = getEditor();
    if (!view) return;
    if (rect) clearTableRect(view, rect);
    else applyTableAction(view, { type: "clearCell" });
    focus();
    onClose();
  };

  return (
    <div
      className="ctxmenu table-context-menu"
      style={{ left, top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="table-context-meta">
        {selectionLabel} · {rows}x{cols}
      </div>
      <MenuItem icon="copy" label="复制选区" onClick={() => void copySelection()} />
      <MenuItem icon="edit" label="粘贴到选区起点" onClick={() => void pasteSelection()} />
      <MenuItem icon="trash" label="清空选区" danger onClick={clearSelection} />
      <div className="ctx-sep" />
      <MenuItem label="上方插入行" onClick={() => run({ type: "insertRowAbove" })} />
      <MenuItem label="下方插入行" onClick={() => run({ type: "insertRowBelow" })} />
      <MenuItem label="左侧插入列" onClick={() => run({ type: "insertColLeft" })} />
      <MenuItem label="右侧插入列" onClick={() => run({ type: "insertColRight" })} />
      <div className="ctx-sep" />
      <MenuItem label="按当前列升序" onClick={() => run({ type: "sortAsc" })} />
      <MenuItem label="按当前列降序" onClick={() => run({ type: "sortDesc" })} />
      <MenuItem label="整理表格宽度" onClick={() => run({ type: "format" })} />
      <div className="ctx-sep" />
      <MenuItem icon="trash" label="删除当前行" danger onClick={() => run({ type: "deleteRow" })} />
      <MenuItem icon="trash" label="删除当前列" danger onClick={() => run({ type: "deleteCol" })} />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: "copy" | "edit" | "trash";
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`ctx-item${danger ? " danger" : ""}`} onClick={onClick}>
      <span className="ico">{icon ? <Icon name={icon} size={13} /> : null}</span>
      <span className="lbl">{label}</span>
    </button>
  );
}
