import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  width?: number;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

export function ToolbarMenuPortal({
  anchorRef,
  align = "left",
  width,
  className,
  onClose,
  children,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    left: 0,
    top: 0,
    marginTop: 0,
    visibility: "hidden",
    zIndex: 1200,
  });

  const updatePosition = () => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const menuWidth = width ?? menuRef.current?.offsetWidth ?? 240;
    const menuHeight = menuRef.current?.offsetHeight ?? 260;
    const gap = 6;
    const viewportGap = 8;
    const leftBase = align === "right" ? rect.right - menuWidth : rect.left;
    const left = Math.max(
      viewportGap,
      Math.min(leftBase, window.innerWidth - menuWidth - viewportGap),
    );
    const below = rect.bottom + gap;
    const top =
      below + menuHeight > window.innerHeight - viewportGap
        ? Math.max(viewportGap, rect.top - menuHeight - gap)
        : below;

    setStyle({
      position: "fixed",
      left,
      top,
      width: width ?? undefined,
      marginTop: 0,
      visibility: "visible",
      zIndex: 1200,
    });
  };

  useLayoutEffect(() => {
    updatePosition();
  }, [align, width]);

  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        anchorRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const update = () => updatePosition();

    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className={className ? `new-menu ${className}` : "new-menu"}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
