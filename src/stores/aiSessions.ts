import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type AIScope = "all" | "folder" | "open" | "tag" | "custom";

export interface AIMsgRecord {
  id: string;
  role: "user" | "assistant";
  text: string;
  time: number;
}

export interface AISession {
  id: string;
  workspaceId: string | null;
  title: string;
  /** AI 模式（提问 / 总结 / 写作...）记录创建时使用的模式 */
  mode: string;
  messages: AIMsgRecord[];
  createdAt: number;
  updatedAt: number;
}

interface AISessionsState {
  sessions: AISession[];
  activeId: string | null;
  scope: AIScope;
  scopeTag: string | null;
  /** 手动选择模式下，用户挑入的笔记路径集合 */
  customPaths: string[];

  createSession: (
    workspaceId: string | null,
    mode: string,
  ) => string;
  setActive: (id: string | null) => void;
  appendMessage: (sessionId: string, msg: AIMsgRecord) => void;
  setTitle: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  clearAll: () => void;
  setScope: (s: AIScope) => void;
  setScopeTag: (t: string | null) => void;
  setCustomPaths: (paths: string[]) => void;
  activeSession: () => AISession | undefined;
}

function newId() {
  return `s${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
}

function deriveTitle(msg: AIMsgRecord): string {
  const t = msg.text.replace(/\s+/g, " ").trim();
  return t.length > 28 ? t.slice(0, 28) + "…" : t || "新对话";
}

export const useAISessions = create<AISessionsState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeId: null,
      scope: "all",
      scopeTag: null,
      customPaths: [],

      createSession: (workspaceId, mode) => {
        const id = newId();
        const now = Date.now();
        const s: AISession = {
          id,
          workspaceId,
          title: "新对话",
          mode,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        set((st) => ({
          sessions: [s, ...st.sessions],
          activeId: id,
        }));
        return id;
      },

      setActive: (id) => set({ activeId: id }),

      appendMessage: (sessionId, msg) =>
        set((st) => ({
          sessions: st.sessions.map((s) => {
            if (s.id !== sessionId) return s;
            const isFirstUser =
              s.messages.length === 0 && msg.role === "user";
            return {
              ...s,
              messages: [...s.messages, msg],
              title: isFirstUser ? deriveTitle(msg) : s.title,
              updatedAt: msg.time,
            };
          }),
        })),

      setTitle: (id, title) =>
        set((st) => ({
          sessions: st.sessions.map((s) =>
            s.id === id ? { ...s, title } : s,
          ),
        })),

      deleteSession: (id) =>
        set((st) => {
          const next = st.sessions.filter((s) => s.id !== id);
          return {
            sessions: next,
            activeId: st.activeId === id ? next[0]?.id ?? null : st.activeId,
          };
        }),

      clearAll: () => set({ sessions: [], activeId: null }),

      setScope: (scope) => set({ scope }),
      setScopeTag: (scopeTag) => set({ scopeTag }),
      setCustomPaths: (customPaths) => set({ customPaths }),

      activeSession: () => {
        const id = get().activeId;
        return id ? get().sessions.find((s) => s.id === id) : undefined;
      },
    }),
    {
      name: "markio.aiSessions.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        sessions: s.sessions,
        activeId: s.activeId,
        scope: s.scope,
        scopeTag: s.scopeTag,
        customPaths: s.customPaths,
      }),
    },
  ),
);
