import { useEffect, useRef, useState } from "react";
import { useStreak } from "@/stores/streak";

export function WritingGoalChip() {
  const target = useStreak((s) => s.dailyTarget);
  const today = useStreak((s) => s.todayWords);
  const streak = useStreak((s) => s.streak);
  const setTarget = useStreak((s) => s.setTarget);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  const pct = Math.min(100, target > 0 ? (today / target) * 100 : 0);

  return (
    <div className="wg" ref={wrapRef}>
      <button
        type="button"
        className="wg-chip"
        onClick={() => setOpen((v) => !v)}
        title={`今日写作 ${today} / ${target}`}
      >
        <span aria-hidden style={{ fontSize: 11 }}>📝</span>
        <span>
          <b>{today}</b> / {target}
        </span>
        <span className="wg-bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </span>
      </button>
      {open && (
        <div className="wg-panel">
          <div className="wg-h">
            <span style={{ fontSize: 14, fontWeight: 700 }}>写作目标</span>
            <button
              className="wg-edit"
              title="编辑目标"
              onClick={() => {
                const v = window.prompt("每日目标（字符数）", String(target));
                if (!v) return;
                const n = parseInt(v, 10);
                if (Number.isFinite(n)) setTarget(n);
              }}
            >
              ✎
            </button>
          </div>
          <div className="wg-progress-cards">
            <div className="wg-pc">
              <div className="wg-pc-l">今日</div>
              <div className="wg-pc-v">
                <b>{today}</b> / {target}
              </div>
              <div className="wg-pc-bar">
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
          <div className="wg-streak-row">
            <span className="wg-flame" aria-hidden>🔥</span>
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--accent)",
                }}
              >
                {streak} 天连续写作
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {today >= target
                  ? "今日目标已达成"
                  : `还差 ${Math.max(0, target - today)} 字`}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
