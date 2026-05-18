import { create } from "zustand";

export type DiagnosticSeverity = "warning" | "error";

export interface DiagnosticItem {
  id: string;
  source: string;
  severity: DiagnosticSeverity;
  message: string;
  detail?: string;
  workspace?: string;
  timestamp: number;
  seen: boolean;
}

interface DiagnosticInput {
  source: string;
  severity?: DiagnosticSeverity;
  message: string;
  detail?: unknown;
  workspace?: string;
}

interface DiagnosticsState {
  items: DiagnosticItem[];
  report: (input: DiagnosticInput) => void;
  markAllSeen: () => void;
  clear: () => void;
}

const MAX_ITEMS = 30;
const DEDUPE_WINDOW_MS = 60_000;
let seq = 0;

function detailToString(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  if (detail instanceof Error) return detail.message;
  return String(detail);
}

export const useDiagnostics = create<DiagnosticsState>((set) => ({
  items: [],
  report: (input) =>
    set((state) => {
      const now = Date.now();
      const detail = detailToString(input.detail);
      const idx = state.items.findIndex(
        (item) =>
          item.source === input.source &&
          item.message === input.message &&
          item.workspace === input.workspace &&
          now - item.timestamp < DEDUPE_WINDOW_MS,
      );
      if (idx >= 0) {
        const next = [...state.items];
        next[idx] = {
          ...next[idx],
          severity: input.severity ?? next[idx].severity,
          detail,
          timestamp: now,
          seen: false,
        };
        return { items: next };
      }
      const item: DiagnosticItem = {
        id: `d${now}${seq++}`,
        source: input.source,
        severity: input.severity ?? "warning",
        message: input.message,
        detail,
        workspace: input.workspace,
        timestamp: now,
        seen: false,
      };
      return { items: [item, ...state.items].slice(0, MAX_ITEMS) };
    }),
  markAllSeen: () =>
    set((state) => ({
      items: state.items.map((item) => ({ ...item, seen: true })),
    })),
  clear: () => set({ items: [] }),
}));

export function reportDiagnostic(input: DiagnosticInput): void {
  useDiagnostics.getState().report(input);
}
