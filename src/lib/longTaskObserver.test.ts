// @vitest-environment happy-dom
//
// Tests for the local long-task observer. Mocks PerformanceObserver to drive
// entries synchronously; verifies entries route to the in-app diagnostics
// store (no network, no Sentry — this is the local-first design).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLongTaskObserver } from "./longTaskObserver";
import { useDiagnostics } from "@/stores/diagnostics";

// ---- Fake PerformanceObserver -----------------------------------------------
type Listener = (list: { getEntries: () => PerformanceEntry[] }) => void;

class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];
  static supportedEntryTypes: readonly string[] = ["longtask", "measure"];
  entryTypes: string[] = [];
  disconnected = false;
  constructor(public readonly listener: Listener) {
    FakePerformanceObserver.instances.push(this);
  }
  observe(options: { entryTypes: string[] }) {
    this.entryTypes = options.entryTypes;
  }
  disconnect() {
    this.disconnected = true;
  }
  // Test helper
  emit(entries: PerformanceEntry[]) {
    if (this.disconnected) return;
    this.listener({ getEntries: () => entries });
  }
}

function entry(type: string, name: string, duration: number): PerformanceEntry {
  return {
    entryType: type,
    name,
    startTime: 0,
    duration,
    toJSON: () => ({}),
  } as PerformanceEntry;
}

beforeEach(() => {
  FakePerformanceObserver.instances = [];
  (globalThis as unknown as { PerformanceObserver: typeof FakePerformanceObserver }).PerformanceObserver =
    FakePerformanceObserver;
  useDiagnostics.setState({ items: [] });
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).PerformanceObserver;
  delete (window as unknown as Record<string, unknown>).__markioPerf;
});

describe("installLongTaskObserver — gating", () => {
  it("is a no-op when not enabled", () => {
    const handle = installLongTaskObserver();
    handle.disconnect();
    expect(FakePerformanceObserver.instances).toHaveLength(0);
  });

  it("activates when window.__markioPerf is true", () => {
    window.__markioPerf = true;
    installLongTaskObserver();
    expect(FakePerformanceObserver.instances.length).toBeGreaterThan(0);
  });

  it("activates when options.enabled = true", () => {
    installLongTaskObserver({ enabled: true });
    expect(FakePerformanceObserver.instances.length).toBeGreaterThan(0);
  });

  it("is a no-op when PerformanceObserver is missing", () => {
    delete (globalThis as unknown as Record<string, unknown>).PerformanceObserver;
    const handle = installLongTaskObserver({ enabled: true });
    handle.disconnect();
    expect(useDiagnostics.getState().items).toHaveLength(0);
  });
});

describe("installLongTaskObserver — routing", () => {
  it("longtask entries become diagnostic warnings", () => {
    installLongTaskObserver({ enabled: true });
    const obs = FakePerformanceObserver.instances.find((o) =>
      o.entryTypes.includes("longtask"),
    )!;
    obs.emit([entry("longtask", "self", 120)]);
    const item = useDiagnostics.getState().items[0]!;
    expect(item.source).toBe("performance");
    expect(item.severity).toBe("warning");
    expect(item.message).toBe("主线程长任务");
    expect(item.detail).toBe("120ms");
  });

  it("measure entries are routed when name starts with preview: AND above threshold", () => {
    installLongTaskObserver({ enabled: true, measureThresholdMs: 100 });
    const obs = FakePerformanceObserver.instances.find((o) =>
      o.entryTypes.includes("measure"),
    )!;
    obs.emit([
      entry("measure", "preview:renderMermaid", 250), // pass
      entry("measure", "preview:renderMath", 50), // below threshold
      entry("measure", "other:foo", 9999), // wrong name
    ]);
    const items = useDiagnostics.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toBe("渲染慢：preview:renderMermaid");
    expect(items[0]!.detail).toBe("250ms");
  });

  it("dedupes repeated reports per the diagnostics store's window", () => {
    installLongTaskObserver({ enabled: true });
    const obs = FakePerformanceObserver.instances.find((o) =>
      o.entryTypes.includes("longtask"),
    )!;
    obs.emit([entry("longtask", "self", 60)]);
    obs.emit([entry("longtask", "self", 90)]);
    // Both share source+message+workspace, so the second updates the first.
    expect(useDiagnostics.getState().items).toHaveLength(1);
    expect(useDiagnostics.getState().items[0]!.detail).toBe("90ms");
  });

  it("disconnect() stops further routing", () => {
    const handle = installLongTaskObserver({ enabled: true });
    handle.disconnect();
    for (const obs of FakePerformanceObserver.instances) {
      expect(obs.disconnected).toBe(true);
      obs.emit([entry("longtask", "self", 999)]);
    }
    expect(useDiagnostics.getState().items).toHaveLength(0);
  });

  it("gracefully skips entry types the WebView doesn't support", () => {
    FakePerformanceObserver.supportedEntryTypes = ["measure"]; // no longtask
    installLongTaskObserver({ enabled: true });
    const obs = FakePerformanceObserver.instances;
    // Only the measure observer should exist
    expect(obs).toHaveLength(1);
    expect(obs[0]!.entryTypes).toEqual(["measure"]);
    // Reset for the other tests in this file
    FakePerformanceObserver.supportedEntryTypes = ["longtask", "measure"];
  });
});
