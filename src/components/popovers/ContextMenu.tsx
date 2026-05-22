import { useEffect } from "react";
import { Icon, type IconName } from "../ui/Icon";

export interface CtxItem {
  label?: string;
  icon?: IconName;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  onClick?: () => void;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const dismissClick = () => onClose();
    // 在另一个行/区域上右键时，那个 handler 会先 setState({新菜单}) 并 e.preventDefault()；
    // 紧接着原生事件继续冒泡到 window，如果这里无条件 onClose，会把 React 刚 schedule
    // 的新 ctx 又改回 null，新菜单永远不出现。靠 defaultPrevented 区分：被处理过的事件
    // 说明上游会自己开新菜单，旧菜单只需安静卸载 (新 ctx 替换旧 ctx 自动卸载旧实例)。
    const dismissCtx = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", dismissClick);
    window.addEventListener("contextmenu", dismissCtx);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismissClick);
      window.removeEventListener("contextmenu", dismissCtx);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const maxHeight = Math.max(120, Math.min(window.innerHeight - 16, items.length * 30));
  const left = Math.max(8, Math.min(x, window.innerWidth - 248));
  const top = Math.max(8, Math.min(y, window.innerHeight - maxHeight - 8));

  return (
    <div
      className="ctxmenu"
      style={{ left, top, maxHeight }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div className="ctx-sep" key={i} />
        ) : (
          <button
            type="button"
            key={i}
            className={"ctx-item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
          >
            <span className="ico">
              {it.icon ? <Icon name={it.icon} size={13} /> : null}
            </span>
            <span className="lbl">{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>
  );
}
