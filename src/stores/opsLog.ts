import { create } from "zustand";

// 操作日志（ops log）：仅记"用户视角的动作类型"，不存内容、不存路径。
// 用途：反馈表单勾上"操作记录"时附带最近 N 条，帮助复现 bug。
// 默认关，store 持续在内存累积；用户不勾就永远不会出 markio 进程。
//
// 隐私红线：
// - 不记文件名 / 路径 / 内容
// - 不记 API key / 用户输入文本 / 搜索 query
// - 不记远端 URL / commit message / 邮箱
// - meta 字段只允许结构化标签（"large" / "split" / "anthropic" / true / 数字）
//
// 调用方式：
//   import { recordOp } from "@/stores/opsLog";
//   recordOp("file:open", { size: "large" });
//   recordOp("ai:send", { provider: "anthropic", agentMode: true });

export type OpMeta = Record<string, string | number | boolean>;

export interface OpEntry {
  id: string;
  type: string;
  meta?: OpMeta;
  timestamp: number;
}

interface OpsLogState {
  items: OpEntry[];
  record: (type: string, meta?: OpMeta) => void;
  clear: () => void;
}

const MAX_ITEMS = 50;
// 同 type 同 meta 在 800ms 内合并为一条，避免快速按键灌满 buffer
const DEDUPE_WINDOW_MS = 800;
let seq = 0;

function metaEqual(a: OpMeta | undefined, b: OpMeta | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export const useOpsLog = create<OpsLogState>((set) => ({
  items: [],
  record: (type, meta) =>
    set((state) => {
      const now = Date.now();
      const last = state.items[0];
      if (
        last &&
        last.type === type &&
        metaEqual(last.meta, meta) &&
        now - last.timestamp < DEDUPE_WINDOW_MS
      ) {
        // 时间窗口内重复操作，只更新时间戳避免日志噪音
        const next = [...state.items];
        next[0] = { ...last, timestamp: now };
        return { items: next };
      }
      const entry: OpEntry = {
        id: `o${now}${seq++}`,
        type,
        meta,
        timestamp: now,
      };
      return { items: [entry, ...state.items].slice(0, MAX_ITEMS) };
    }),
  clear: () => set({ items: [] }),
}));

export function recordOp(type: string, meta?: OpMeta): void {
  useOpsLog.getState().record(type, meta);
}

/** 取最近 N 条用于反馈附件 */
export function getRecentOps(limit = MAX_ITEMS): OpEntry[] {
  return useOpsLog.getState().items.slice(0, limit);
}

/** 把 bytes 大小映射为粗粒度标签，避免泄露具体大小 */
export function sizeBucket(bytes: number): "tiny" | "small" | "medium" | "large" | "huge" {
  if (bytes < 4 * 1024) return "tiny";
  if (bytes < 64 * 1024) return "small";
  if (bytes < 512 * 1024) return "medium";
  if (bytes < 4 * 1024 * 1024) return "large";
  return "huge";
}

/** 提取文件扩展名（小写、不含点）。无扩展名返回 "none"。仅作为类型标签，不含路径或文件名。 */
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  if (i <= 0) return "none";
  return base.slice(i + 1).toLowerCase().slice(0, 8);
}
