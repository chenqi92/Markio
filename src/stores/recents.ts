import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface RecentItem {
  workspaceId: string;
  path: string;
  name: string;
  at: number;
}

interface RecentsState {
  items: RecentItem[];
  push: (workspaceId: string, path: string, name: string) => void;
  forget: (path: string) => void;
}

const MAX = 30;

export const useRecents = create<RecentsState>()(
  persist(
    (set) => ({
      items: [],
      push: (workspaceId, path, name) =>
        set((s) => {
          const next = [
            { workspaceId, path, name, at: Date.now() },
            ...s.items.filter((it) => it.path !== path),
          ].slice(0, MAX);
          return { items: next };
        }),
      forget: (path) =>
        set((s) => ({ items: s.items.filter((it) => it.path !== path) })),
    }),
    {
      name: "markio.recents.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
