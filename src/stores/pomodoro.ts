import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/lib/tauriStorage";

export type PomodoroMode = "focus" | "short" | "long";

const DURATION: Record<PomodoroMode, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface State {
  mode: PomodoroMode;
  /** 当前剩余秒数 */
  remaining: number;
  /** 是否正在运行 */
  running: boolean;
  /** 上一次 tick 的时间戳（避免 setInterval 漂移） */
  lastTick: number | null;
  /** 持久化：当日已完成的 focus 局数 */
  completedDay: string;
  completedFocus: number;
  start: () => void;
  pause: () => void;
  reset: (mode?: PomodoroMode) => void;
  setMode: (mode: PomodoroMode) => void;
  /** 由全局 ticker 每秒触发 */
  tick: () => void;
}

export const usePomodoro = create<State>()(
  persist(
    (set, get) => ({
      mode: "focus",
      remaining: DURATION.focus,
      running: false,
      lastTick: null,
      completedDay: todayKey(),
      completedFocus: 0,
      start: () => set({ running: true, lastTick: Date.now() }),
      pause: () => set({ running: false, lastTick: null }),
      reset: (mode) => {
        const m = mode ?? get().mode;
        set({ mode: m, remaining: DURATION[m], running: false, lastTick: null });
      },
      setMode: (mode) =>
        set({ mode, remaining: DURATION[mode], running: false, lastTick: null }),
      tick: () => {
        const s = get();
        if (!s.running) return;
        const now = Date.now();
        const delta = s.lastTick ? Math.floor((now - s.lastTick) / 1000) : 1;
        if (delta < 1) return;
        const next = s.remaining - delta;
        if (next > 0) {
          set({ remaining: next, lastTick: s.lastTick! + delta * 1000 });
          return;
        }
        // 完成本局
        const tk = todayKey();
        const wasFocus = s.mode === "focus";
        const completedDay = s.completedDay === tk ? s.completedDay : tk;
        const completedFocus =
          s.completedDay === tk
            ? s.completedFocus + (wasFocus ? 1 : 0)
            : wasFocus
            ? 1
            : 0;
        set({
          running: false,
          lastTick: null,
          remaining: DURATION[s.mode],
          completedDay,
          completedFocus,
        });
        try {
          new Notification(
            wasFocus ? "专注完成 · 休息一下" : "休息结束 · 继续专注",
          );
        } catch {
          /* ignore */
        }
      },
    }),
    {
      name: "markio.pomodoro.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
      partialize: (s) => ({
        completedDay: s.completedDay,
        completedFocus: s.completedFocus,
      }),
    },
  ),
);
