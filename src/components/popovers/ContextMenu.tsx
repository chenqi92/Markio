import { useEffect } from "react";
import { Icon, type IconName } from "../ui/Icon";

export interface CtxItem {
  label?: string;
  icon?: IconName;
  kbd?: string;
  danger?: boolean;
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
    const dismiss = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
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
            onClick={() => {
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
