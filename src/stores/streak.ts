import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/lib/tauriStorage";

/**
 * 本地"写作连击"统计：
 *  - 每次保存 / 内容变化时调用 `track(charsDelta)`
 *  - 当天累计字数计入今日，目标 500 字
 *  - 跨天且当天有写作过 → 连击 + 1；否则连击清零（再写又从 1 开始）
 */
interface StreakState {
  dailyTarget: number;
  today: string;
  todayWords: number;
  streak: number;
  lastWritten: string | null;
  track: (deltaChars: number) => void;
  setTarget: (n: number) => void;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayDiff(a: string | null, b: string): number {
  if (!a) return 99;
  const ad = new Date(a);
  const bd = new Date(b);
  return Math.round((bd.getTime() - ad.getTime()) / 86_400_000);
}

export const useStreak = create<StreakState>()(
  persist(
    (set, get) => ({
      dailyTarget: 500,
      today: todayKey(),
      todayWords: 0,
      streak: 0,
      lastWritten: null,
      track: (deltaChars) => {
        if (deltaChars <= 0) return;
        const tk = todayKey();
        const s = get();
        if (s.today !== tk) {
          // 新的一天
          const diff = dayDiff(s.lastWritten, tk);
          const newStreak = diff === 1 ? s.streak + 1 : 1;
          set({
            today: tk,
            todayWords: deltaChars,
            streak: newStreak,
            lastWritten: tk,
          });
        } else {
          set({
            todayWords: s.todayWords + deltaChars,
            lastWritten: tk,
            streak: s.streak === 0 ? 1 : s.streak,
          });
        }
      },
      setTarget: (dailyTarget) =>
        set({ dailyTarget: Math.max(50, Math.min(5000, dailyTarget)) }),
    }),
    {
      name: "markio.streak.v1",
      storage: createJSONStorage(() => tauriStorage),
      skipHydration: true,
    },
  ),
);
