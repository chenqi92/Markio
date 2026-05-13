import { useCallback, useRef } from "react";
import { useUI } from "@/stores/ui";

export function SidebarResizer() {
  const setW = useUI((s) => s.setSidebarWidth);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const next = startW.current + (e.clientX - startX.current);
      setW(next);
    },
    [setW],
  );

  const onMouseUp = useCallback(() => {
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = useUI.getState().sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return <div className="sidebar-resizer" onMouseDown={onMouseDown} />;
}
