import { classNames } from "@/lib/utils";

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

export function SelectBtn({
  value,
  onClick,
}: {
  value: string;
  onClick?: () => void;
}) {
  return (
    <button className="select-btn" onClick={onClick} type="button">
      {value}
      <span style={{ opacity: 0.5, marginLeft: 4 }}>▾</span>
    </button>
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
