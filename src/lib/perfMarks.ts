// Lightweight `performance.mark` / `measure` wrappers for hot paths.
// Why: when a user reports "卡顿 on big docs", DevTools Performance can
// show our named marks alongside browser tasks — much faster than re-adding
// console.time() each debug session.
//
// Enabled via `window.__markioPerf = true` in DevTools (or
// `?perf=1` URL param). Otherwise calls are ~no-ops so production users
// see no overhead.

declare global {
  interface Window {
    __markioPerf?: boolean;
  }
}

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__markioPerf === true) return true;
  try {
    if (window.location?.search?.includes("perf=1")) {
      window.__markioPerf = true;
      return true;
    }
  } catch {
    /* SSR / restricted contexts */
  }
  return false;
}

export function perfMark(name: string): void {
  if (!isEnabled() || typeof performance === "undefined") return;
  try {
    performance.mark(name);
  } catch {
    /* ignore */
  }
}

/**
 * Measures `fn()` between two marks; returns the value `fn` returned.
 * Logs `[perf] <label>: <ms>ms` and emits a `performance.measure` so the
 * span shows up in the DevTools Timings track.
 */
export function perfMeasure<T>(label: string, fn: () => T): T {
  if (!isEnabled()) return fn();
  const start = `${label}:start`;
  const end = `${label}:end`;
  try {
    performance.mark(start);
  } catch {
    /* ignore */
  }
  const t0 = performance.now();
  const result = fn();
  const dt = performance.now() - t0;
  try {
    performance.mark(end);
    performance.measure(label, start, end);
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${dt.toFixed(2)}ms`);
  return result;
}

export async function perfMeasureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isEnabled()) return fn();
  const start = `${label}:start`;
  const end = `${label}:end`;
  try {
    performance.mark(start);
  } catch {
    /* ignore */
  }
  const t0 = performance.now();
  const result = await fn();
  const dt = performance.now() - t0;
  try {
    performance.mark(end);
    performance.measure(label, start, end);
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${dt.toFixed(2)}ms`);
  return result;
}
