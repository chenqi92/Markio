import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { classNames } from "@/lib/utils";
import { Icon } from "./Icon";

type SelectValue = string | number;

export interface SelectOption<T extends SelectValue = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

interface SelectBtnProps<T extends SelectValue = string> {
  value: T;
  options?: readonly SelectOption<T>[];
  onChange?: (value: T) => void;
  onClick?: () => void;
  align?: "left" | "right";
  minMenuWidth?: number;
}

export function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={classNames("sw", on && "on")}
      onClick={() => onChange?.(!on)}
      aria-pressed={on}
    >
      <span />
    </button>
  );
}

export function SelectBtn<T extends SelectValue = string>({
  value,
  options = [],
  onChange,
  onClick,
  align = "right",
  minMenuWidth = 180,
}: SelectBtnProps<T>) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const selected = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const interactive = options.length > 0 && !!onChange;

  const updatePosition = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.max(rect.width, minMenuWidth);
    const gap = 6;
    const viewportGap = 8;
    const estimatedHeight =
      menuRef.current?.offsetHeight ?? Math.min(320, options.length * 42 + 8);
    const leftBase = align === "right" ? rect.right - width : rect.left;
    const left = Math.max(
      viewportGap,
      Math.min(leftBase, window.innerWidth - width - viewportGap),
    );
    const below = rect.bottom + gap;
    const top =
      below + estimatedHeight > window.innerHeight - viewportGap
        ? Math.max(viewportGap, rect.top - estimatedHeight - gap)
        : below;
    setPos({ left, top, width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    updatePosition();
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const update = () => updatePosition();
    const dismiss = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((i) => {
          let next = i;
          for (let step = 0; step < options.length; step += 1) {
            next = (next + dir + options.length) % options.length;
            if (!options[next]?.disabled) break;
          }
          return next;
        });
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const option = options[activeIndex];
        if (option && !option.disabled) {
          onChange?.(option.value);
          setOpen(false);
          btnRef.current?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [activeIndex, open, onChange, options]);

  const toggle = () => {
    if (!interactive) {
      onClick?.();
      return;
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={btnRef}
        className={classNames("select-btn", open && "open")}
        onClick={toggle}
        onKeyDown={(e) => {
          if (!interactive) return;
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        type="button"
        aria-haspopup={interactive ? "listbox" : undefined}
        aria-expanded={interactive ? open : undefined}
      >
        <span className="select-btn-label">{selected?.label ?? String(value)}</span>
        <Icon name="chevdown" size={13} />
      </button>
      {open &&
        interactive &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="select-menu"
            style={pos}
            role="listbox"
            aria-activedescendant={`select-option-${activeIndex}`}
          >
            {options.map((option, i) => (
              <button
                type="button"
                id={`select-option-${i}`}
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                key={`${option.value}`}
                className={classNames(
                  "select-option",
                  option.value === value && "selected",
                  i === activeIndex && "active",
                )}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  if (option.disabled) return;
                  onChange?.(option.value);
                  setOpen(false);
                  btnRef.current?.focus();
                }}
              >
                <span className="select-option-copy">
                  <span className="select-option-label">{option.label}</span>
                  {option.description && (
                    <span className="select-option-desc">{option.description}</span>
                  )}
                </span>
                {option.value === value && <Icon name="check" size={13} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Slider({
  value,
  min = 0,
  max = 100,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange?: (n: number) => void;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="slider-wrap">
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          width: "100%",
          height: 4,
          background: "transparent",
          position: "relative",
          opacity: 0,
          cursor: "pointer",
          zIndex: 2,
          margin: 0,
        }}
      />
      <div className="slider" style={{ marginTop: -10, pointerEvents: "none" }}>
        <div style={{ width: pct + "%" }} />
        <div className="thumb" style={{ left: pct + "%" }} />
      </div>
    </div>
  );
}
