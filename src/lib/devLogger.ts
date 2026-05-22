/**
 * 开发期日志（dev-only）。
 *
 * 仅当 `import.meta.env.DEV === true` 时由 main.tsx 调用 `installDevLogger()`：
 *  - 拦截 `console.log/info/warn/error/debug`（保留原始打印，同时投递到 Rust）
 *  - 监听 `window.error` / `window.unhandledrejection`
 *  - 监听 Vite HMR 事件（vite:beforeUpdate / vite:invalidate / vite:error）
 *  - 暴露 `devLog(level, msg, fields?)` 给业务侧手动埋点
 *  - 暴露 `wrapInvoke(name, fn)` 给 api.ts 给每次 invoke 打点
 *
 * 投递走批量 flush：每条入队后 250ms debounce，或 `beforeunload` 强制 flush。
 * 不阻塞渲染、不丢条目（队列在内存，进程退出前 flush）。
 *
 * Release 构建里 main.tsx 的 `if (import.meta.env.DEV)` 会被 Vite 直接 dead-code
 * eliminate，本模块整段不进入产物；Rust 侧 dev_log_append 也是 no-op，双保险。
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type Level = "log" | "info" | "warn" | "error" | "debug" | "fatal";

interface QueueItem {
  level: Level;
  src: string;
  msg: string;
  fields?: Record<string, unknown>;
}

const QUEUE: QueueItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
/** 避免日志投递自身报错时再触发 console.error → 无限递归。 */
let suppressDepth = 0;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeStringify(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (v instanceof Error) {
    return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ""}`;
  }
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      return val;
    });
  } catch {
    return String(v);
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(safeStringify).join(" ");
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 250);
}

async function flush() {
  if (QUEUE.length === 0) return;
  if (!isTauri()) {
    // 浏览器调试模式：没有 Tauri 后端，直接丢弃（原始 console 已经打过了）
    QUEUE.length = 0;
    return;
  }
  const batch = QUEUE.splice(0, QUEUE.length);
  suppressDepth += 1;
  try {
    // 一条一条发，避免一条编码失败拖累整批。
    for (const item of batch) {
      try {
        await tauriInvoke("dev_log_append", {
          level: item.level,
          src: item.src,
          msg: item.msg,
          fields: item.fields ?? null,
        });
      } catch {
        // 静默忽略；调试日志不能反过来影响主流程
      }
    }
  } finally {
    suppressDepth -= 1;
  }
}

function enqueue(item: QueueItem) {
  if (suppressDepth > 0) return;
  QUEUE.push(item);
  scheduleFlush();
}

/** 业务手动埋点。msg 是人读字符串，fields 是结构化补充（耗时、key 等）。 */
export function devLog(
  level: Level,
  msg: string,
  fields?: Record<string, unknown>,
) {
  if (!installed) return;
  enqueue({ level, src: "fe", msg, fields });
}

/** 给 invoke 加耗时/错误打点。在 api.ts 里替换裸 invoke。 */
export async function wrapInvoke<T>(
  cmd: string,
  call: () => Promise<T>,
): Promise<T> {
  if (!installed) return call();
  const t0 = performance.now();
  try {
    const r = await call();
    const ms = Math.round(performance.now() - t0);
    // 不要把 dev_log_append 自己刷出来 —— 否则无限循环
    if (cmd !== "dev_log_append") {
      enqueue({
        level: "debug",
        src: "invoke",
        msg: cmd,
        fields: { ms },
      });
    }
    return r;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    enqueue({
      level: "error",
      src: "invoke",
      msg: `${cmd} failed`,
      fields: {
        ms,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    throw e;
  }
}

function patchConsole() {
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  for (const lv of levels) {
    // eslint-disable-next-line no-console
    const orig = console[lv].bind(console);
    // eslint-disable-next-line no-console
    console[lv] = (...args: unknown[]) => {
      try {
        enqueue({ level: lv, src: "console", msg: formatArgs(args) });
      } catch {
        /* ignore */
      }
      orig(...args);
    };
  }
}

function hookErrors() {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (e) => {
    enqueue({
      level: "error",
      src: "window",
      msg: e.message || "(unknown error)",
      fields: {
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        stack: e.error instanceof Error ? e.error.stack : undefined,
      },
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as unknown;
    enqueue({
      level: "error",
      src: "promise",
      msg:
        reason instanceof Error
          ? `${reason.name}: ${reason.message}`
          : safeStringify(reason),
      fields: {
        stack: reason instanceof Error ? reason.stack : undefined,
      },
    });
  });
}

function hookHmr() {
  // import.meta.hot 在 dev 一定存在；用 try/catch 防 TS 推断 narrow 出错
  const hot = (import.meta as unknown as { hot?: ViteHotContext }).hot;
  if (!hot) return;
  const evts = [
    "vite:beforeUpdate",
    "vite:afterUpdate",
    "vite:invalidate",
    "vite:error",
    "vite:beforeFullReload",
    "vite:ws:disconnect",
    "vite:ws:connect",
  ] as const;
  for (const name of evts) {
    try {
      hot.on(name, (payload: unknown) => {
        enqueue({
          level: name === "vite:error" ? "error" : "debug",
          src: "hmr",
          msg: name,
          fields:
            typeof payload === "object" && payload != null
              ? (payload as Record<string, unknown>)
              : { payload: safeStringify(payload) },
        });
      });
    } catch {
      /* 某些事件 vite 版本不一定有 */
    }
  }
}

interface ViteHotContext {
  on(name: string, cb: (payload: unknown) => void): void;
}

/** 在 main.tsx bootstrap 最前面调用。重复调用安全。 */
export function installDevLogger() {
  if (installed) return;
  installed = true;
  patchConsole();
  hookErrors();
  hookHmr();
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      // 同步路径：把队列丢弃前最后再调一次（异步），尽量送出去
      void flush();
    });
  }
  enqueue({
    level: "info",
    src: "boot",
    msg: "devLogger installed",
    fields: { ts: nowIso(), ua: navigator?.userAgent ?? "?" },
  });
}
