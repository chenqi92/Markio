import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/lib/tauriStorage";

export type PomodoroMode = "focus" | "short" | "long";

const DURATION: Record<PomodoroMode, number> = {
  focus: 25 * 60,
  short: 5 * 60,
  long: 15 * 60,
};

function notify(title: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title);
  } catch {
    /* ignore */
  }
}

function requestNotificationPermission() {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => undefined);
  }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayPatch(s: Pick<State, "completedDay">) {
  const tk = todayKey();
  return s.completedDay === tk ? null : { completedDay: tk, completedFocus: 0 };
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
  ensureToday: () => void;
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
      start: () => {
        requestNotificationPermission();
        const patch = todayPatch(get());
        set({ ...(patch ?? {}), running: true, lastTick: Date.now() });
      },
      pause: () => set({ running: false, lastTick: null }),
      reset: (mode) => {
        const m = mode ?? get().mode;
        const patch = todayPatch(get());
        set({ ...(patch ?? {}), mode: m, remaining: DURATION[m], running: false, lastTick: null });
      },
      setMode: (mode) => {
        const patch = todayPatch(get());
        set({ ...(patch ?? {}), mode, remaining: DURATION[mode], running: false, lastTick: null });
      },
      ensureToday: () => {
        const patch = todayPatch(get());
        if (patch) set(patch);
      },
      tick: () => {
        const s = get();
        const patch = todayPatch(s);
        const current = patch ? { ...s, ...patch } : s;
        if (patch) {
          set(patch);
        }
        if (!current.running) return;
        const now = Date.now();
        const delta = current.lastTick ? Math.floor((now - current.lastTick) / 1000) : 1;
        if (delta < 1) return;
        const next = current.remaining - delta;
        if (next > 0) {
          set({ remaining: next, lastTick: current.lastTick! + delta * 1000 });
          return;
        }
        // 完成本局
        const tk = todayKey();
        const wasFocus = current.mode === "focus";
        const completedDay = current.completedDay === tk ? current.completedDay : tk;
        const completedFocus =
          current.completedDay === tk
            ? current.completedFocus + (wasFocus ? 1 : 0)
            : wasFocus
            ? 1
            : 0;
        const nextMode: PomodoroMode = wasFocus
          ? completedFocus > 0 && completedFocus % 4 === 0
            ? "long"
            : "short"
          : "focus";
        set({
          running: false,
          lastTick: null,
          mode: nextMode,
          remaining: DURATION[nextMode],
          completedDay,
          completedFocus,
        });
        notify(wasFocus ? "专注完成 · 休息一下" : "休息结束 · 继续专注");
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
