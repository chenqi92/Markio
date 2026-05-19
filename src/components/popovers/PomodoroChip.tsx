import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { usePomodoro, type PomodoroMode } from "@/stores/pomodoro";

const TOTAL: Record<PomodoroMode, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};
const LABEL: Record<PomodoroMode, string> = {
  focus: "专注",
  short: "小休",
  long: "长休",
};
const COLOR: Record<PomodoroMode, string> = {
  focus: "#ff6b6b",
  short: "#28c840",
  long: "#28c840",
};

export function PomodoroChip() {
  const mode = usePomodoro((s) => s.mode);
  const remaining = usePomodoro((s) => s.remaining);
  const running = usePomodoro((s) => s.running);
  const completedFocus = usePomodoro((s) => s.completedFocus);
  const start = usePomodoro((s) => s.start);
  const pause = usePomodoro((s) => s.pause);
  const reset = usePomodoro((s) => s.reset);
  const setMode = usePomodoro((s) => s.setMode);
  const ensureToday = usePomodoro((s) => s.ensureToday);
  const tick = usePomodoro((s) => s.tick);

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 每秒驱动一次 tick；不运行时不耗资源
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => tick(), 1000);
    return () => window.clearInterval(id);
  }, [running, tick]);

  useEffect(() => {
    ensureToday();
    const id = window.setInterval(ensureToday, 60_000);
    return () => window.clearInterval(id);
  }, [ensureToday]);

  // 点击外部关闭面板
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

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  const pct = 1 - remaining / TOTAL[mode];
  const actionLabel = running ? "暂停" : remaining === TOTAL[mode] ? "开始" : "继续";

  return (
    <div className="pomo" ref={wrapRef}>
      <div className={"pomo-control" + (running ? " running" : "")}>
        <button
          type="button"
          className="pomo-chip"
          onClick={() => (running ? pause() : start())}
          title={`${actionLabel}${LABEL[mode]} · ${mm}:${ss}`}
        >
          <span className="pomo-action" aria-hidden="true">
            <span className="pomo-ring">
              <svg viewBox="0 0 18 18">
                <circle
                  cx="9"
                  cy="9"
                  r="7"
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth="2"
                />
                <circle
                  cx="9"
                  cy="9"
                  r="7"
                  fill="none"
                  stroke={COLOR[mode]}
                  strokeWidth="2"
                  strokeDasharray="44"
                  strokeDashoffset={44 * (1 - pct)}
                  strokeLinecap="round"
                  transform="rotate(-90 9 9)"
                />
              </svg>
            </span>
            <Icon name={running ? "pause" : "play"} size={8} strokeWidth={2.5} />
          </span>
          <span className="pomo-label">{LABEL[mode]}</span>
          <span className="pomo-t">
            {mm}:{ss}
          </span>
        </button>
        <button
          type="button"
          className="pomo-menu-toggle"
          onClick={() => setOpen((v) => !v)}
          title="番茄钟设置"
        >
          <Icon name="chevdown" size={10} />
        </button>
      </div>
      {open && (
        <div className="pomo-panel">
          <div className="pomo-panel-h">番茄钟</div>
          <div className="pomo-time-big">
            {mm}:{ss}
          </div>
          <div className="pomo-modes">
            {(["focus", "short", "long"] as PomodoroMode[]).map((m) => (
              <button
                key={m}
                className={mode === m ? "active" : ""}
                type="button"
                onClick={() => setMode(m)}
              >
                {m === "focus" ? "专注 25′" : m === "short" ? "小休 5′" : "长休 15′"}
              </button>
            ))}
          </div>
          <div className="pomo-ctrl">
            <button
              type="button"
              className="pomo-play"
              onClick={() => (running ? pause() : start())}
            >
              <Icon name={running ? "pause" : "play"} size={12} />
              {running ? "暂停" : "开始"}
            </button>
            <button type="button" onClick={() => reset()}>
              重置
            </button>
          </div>
          <div className="pomo-stats">
            <div>
              <b>{completedFocus}</b>
              <span>今日完成</span>
            </div>
            <div>
              <b>{Math.round((completedFocus * 25) / 60 * 10) / 10}h</b>
              <span>今日专注</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
