// Local-only long-task observer.
//
// Subscribes to two PerformanceObserver streams and forwards interesting
// entries into the in-app diagnostics store (the same one used for sync /
// rag / workspace failures). Data never leaves the device — there is no
// network call here by design (see memory: feedback-no-central-server).
//
//   1. `longtask` entries: any main-thread task >50ms reported by the
//      browser/WebView. Surfaces real-user jank we couldn't reproduce
//      locally.
//   2. `measure` entries whose name starts with `preview:`: the perfMarks
//      we instrument in Preview.tsx. Filtered by `measureThresholdMs` so
//      we only surface unusually slow renders, not every measurement.
//
// Opt-in to keep the diagnostics panel quiet for normal users:
//   - `window.__markioPerf = true`  (set from DevTools), OR
//   - `?perf=1` in the URL.
//
// Returns a `disconnect()` for cleanup (useEffect / HMR / tests).

import { reportDiagnostic } from "@/stores/diagnostics";

export interface LongTaskObserverOptions {
  /** Skip `measure` entries shorter than this. Default 100ms. */
  measureThresholdMs?: number;
  /** Override the gate (handy for tests). */
  enabled?: boolean;
}

export interface LongTaskObserverHandle {
  disconnect(): void;
}

function isEnabled(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  if (typeof window === "undefined") return false;
  if (window.__markioPerf === true) return true;
  try {
    if (window.location?.search?.includes("perf=1")) {
      window.__markioPerf = true;
      return true;
    }
  } catch {
    /* restricted contexts */
  }
  return false;
}

function supportsEntryType(type: string): boolean {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
    .PerformanceObserver;
  if (!PO) return false;
  const types = (PO as unknown as { supportedEntryTypes?: readonly string[] })
    .supportedEntryTypes;
  return Array.isArray(types) ? types.includes(type) : true;
}

function formatLongTask(entry: PerformanceEntry): string {
  const ms = Math.round(entry.duration);
  // Best-effort attribution; not all WebViews populate this.
  const attribution =
    (entry as PerformanceEntry & {
      attribution?: { name?: string; containerType?: string }[];
    }).attribution ?? [];
  const att = attribution
    .map((a) => a.containerType || a.name)
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");
  return att ? `${ms}ms · ${att}` : `${ms}ms`;
}

function formatMeasure(entry: PerformanceEntry): string {
  return `${Math.round(entry.duration)}ms`;
}

const noopHandle: LongTaskObserverHandle = { disconnect: () => undefined };

export function installLongTaskObserver(
  options: LongTaskObserverOptions = {},
): LongTaskObserverHandle {
  if (!isEnabled(options.enabled)) return noopHandle;
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver })
    .PerformanceObserver;
  if (!PO) return noopHandle;

  const threshold = options.measureThresholdMs ?? 100;
  const observers: PerformanceObserver[] = [];

  if (supportsEntryType("longtask")) {
    try {
      const obs = new PO((list) => {
        for (const entry of list.getEntries()) {
          reportDiagnostic({
            source: "performance",
            severity: "warning",
            message: "主线程长任务",
            detail: formatLongTask(entry),
          });
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
      observers.push(obs);
    } catch {
      /* WebView may reject even when supportedEntryTypes lists it */
    }
  }

  if (supportsEntryType("measure")) {
    try {
      const obs = new PO((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.name.startsWith("preview:")) continue;
          if (entry.duration < threshold) continue;
          reportDiagnostic({
            source: "performance",
            severity: "warning",
            message: `渲染慢：${entry.name}`,
            detail: formatMeasure(entry),
          });
        }
      });
      obs.observe({ entryTypes: ["measure"] });
      observers.push(obs);
    } catch {
      /* ignore */
    }
  }

  return {
    disconnect: () => {
      for (const obs of observers) {
        try {
          obs.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
