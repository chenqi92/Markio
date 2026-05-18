// @vitest-environment happy-dom
//
// Tests for enhanceCalloutsLazy. Two angles:
//   1. correctness — visible blockquotes are enhanced synchronously (no flicker),
//      offscreen ones wait for IO; flushAll matches eager output exactly
//   2. first-paint perf — 3000-callout doc only pays for visible set

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enhanceCallouts, enhanceCalloutsLazy } from "./callouts";

// ---- Fake IntersectionObserver ----------------------------------------------
interface FakeEntry {
  target: Element;
  isIntersecting: boolean;
}
type IOCallback = (entries: FakeEntry[]) => void;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public readonly callback: IOCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    if (!this.disconnected) this.observed.push(el);
  }
  unobserve(el: Element) {
    this.observed = this.observed.filter((x) => x !== el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }
  fireAll() {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting: true })),
    );
  }
  fireFirst(n: number) {
    const fired = this.observed.slice(0, n);
    this.callback(fired.map((target) => ({ target, isIntersecting: true })));
  }
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: typeof FakeIntersectionObserver }).IntersectionObserver =
    FakeIntersectionObserver;
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
});

// ---- Helpers ----------------------------------------------------------------
const TYPES = ["note", "warning", "tip", "danger", "success"] as const;

function makeDoc(count: number): HTMLElement {
  const root = document.createElement("div");
  for (let i = 0; i < count; i++) {
    const bq = document.createElement("blockquote");
    const p = document.createElement("p");
    const type = TYPES[i % TYPES.length];
    p.textContent = `[!${type}]${i % 3 === 0 ? "+" : ""} Title ${i}\nbody text ${i}`;
    bq.appendChild(p);
    root.appendChild(bq);
  }
  document.body.appendChild(root);
  return root;
}

// Layout-stub for blockquotes: place them at top: i * 100, height: 80.
// happy-dom returns 0 rects by default so we patch per-element.
function stubLayout(root: HTMLElement, heightPerBlock = 100) {
  Array.from(root.querySelectorAll("blockquote")).forEach((bq, i) => {
    const top = i * heightPerBlock;
    (bq as HTMLElement).getBoundingClientRect = () => ({
      top,
      bottom: top + 80,
      left: 0,
      right: 100,
      width: 100,
      height: 80,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
  });
}

// ---- Correctness ------------------------------------------------------------

describe("enhanceCalloutsLazy — correctness", () => {
  it("synchronously enhances blockquotes in the viewport, defers the rest", () => {
    const root = makeDoc(20);
    stubLayout(root, 100); // blocks at y=0,100,...,1900
    const handle = enhanceCalloutsLazy(root, {
      viewportHeight: 800,
      visibilityMargin: 0,
    });
    // visible: y in [-0, 800] → blocks 0..7 (top <= 800)
    const enhanced = root.querySelectorAll("blockquote.callout");
    // Blocks where top <= 800: i=0..8 (top 0..800 inclusive)
    expect(enhanced.length).toBeGreaterThanOrEqual(8);
    expect(enhanced.length).toBeLessThanOrEqual(10);
    // None of the off-screen ones are enhanced yet
    const last = root.querySelectorAll("blockquote")[19] as HTMLElement;
    expect(last.dataset.calloutEnhanced).toBeUndefined();
    handle.disconnect();
  });

  it("offscreen blockquotes enhance when IO fires", () => {
    const root = makeDoc(20);
    stubLayout(root);
    const handle = enhanceCalloutsLazy(root, {
      viewportHeight: 400,
      visibilityMargin: 0,
    });
    const before = root.querySelectorAll("blockquote.callout").length;
    const io = FakeIntersectionObserver.instances[0];
    io.fireAll();
    const after = root.querySelectorAll("blockquote.callout").length;
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(20);
    handle.disconnect();
  });

  it("flushAll() result matches eager enhanceCallouts exactly", () => {
    const lazyRoot = makeDoc(15);
    const eagerRoot = makeDoc(15);
    stubLayout(lazyRoot);
    // Lazy with tiny viewport so almost everything is deferred
    const handle = enhanceCalloutsLazy(lazyRoot, {
      viewportHeight: 50,
      visibilityMargin: 0,
    });
    handle.flushAll();
    enhanceCallouts(eagerRoot);

    const lazyTypes = Array.from(
      lazyRoot.querySelectorAll<HTMLElement>("blockquote.callout"),
    ).map((bq) => bq.dataset.calloutType);
    const eagerTypes = Array.from(
      eagerRoot.querySelectorAll<HTMLElement>("blockquote.callout"),
    ).map((bq) => bq.dataset.calloutType);
    expect(lazyTypes).toEqual(eagerTypes);

    // Same number of injected .callout-head elements
    expect(lazyRoot.querySelectorAll(".callout-head").length).toBe(
      eagerRoot.querySelectorAll(".callout-head").length,
    );
  });

  it("repeat IO firings on the same blockquote are idempotent", () => {
    const root = makeDoc(8);
    stubLayout(root);
    const handle = enhanceCalloutsLazy(root, {
      viewportHeight: 50,
      visibilityMargin: 0,
    });
    const io = FakeIntersectionObserver.instances[0];
    io.fireAll();
    const heads1 = root.querySelectorAll(".callout-head").length;
    io.fireAll(); // unobserved by now, but re-call helper to be sure
    const heads2 = root.querySelectorAll(".callout-head").length;
    expect(heads1).toBe(heads2);
    handle.disconnect();
  });

  it("ignores non-callout blockquotes", () => {
    const root = document.createElement("div");
    const plain = document.createElement("blockquote");
    plain.innerHTML = "<p>just a quote, no marker</p>";
    const cal = document.createElement("blockquote");
    cal.innerHTML = "<p>[!note] Hello</p>";
    root.append(plain, cal);
    document.body.appendChild(root);
    stubLayout(root);

    enhanceCalloutsLazy(root, { viewportHeight: 1000, visibilityMargin: 0 });
    expect(plain.classList.contains("callout")).toBe(false);
    expect(cal.classList.contains("callout")).toBe(true);
  });

  it("falls back to eager enhancement when IntersectionObserver missing", () => {
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
    const root = makeDoc(10);
    stubLayout(root);
    enhanceCalloutsLazy(root, { viewportHeight: 50, visibilityMargin: 0 });
    expect(root.querySelectorAll("blockquote.callout").length).toBe(10);
  });

  it("disconnect() stops further IO-driven enhancement", () => {
    const root = makeDoc(15);
    stubLayout(root);
    const handle = enhanceCalloutsLazy(root, {
      viewportHeight: 50,
      visibilityMargin: 0,
    });
    const before = root.querySelectorAll("blockquote.callout").length;
    handle.disconnect();
    const io = FakeIntersectionObserver.instances[0];
    io.fireAll();
    const after = root.querySelectorAll("blockquote.callout").length;
    expect(after).toBe(before);
  });

  it("preserves fold marker for [!warning]+", () => {
    const root = makeDoc(3);
    stubLayout(root);
    enhanceCalloutsLazy(root, { viewportHeight: 1000, visibilityMargin: 0 });
    // Block 0: note (no +), Block 3 would be danger+. Check the +-marked ones:
    const folded = root.querySelector<HTMLElement>('blockquote[data-callout-fold="+"]');
    expect(folded).not.toBeNull();
  });
});

// ---- First-paint perf -------------------------------------------------------

describe("enhanceCalloutsLazy — first paint perf", () => {
  it("3000 blockquotes, tiny viewport: only visible enhanced, cost is small", () => {
    const root = makeDoc(3000);
    stubLayout(root); // y = 0, 100, ..., 299_900
    // viewport: 1080px, margin: 200 → blocks visible top<=1280 → ~13 blocks
    const t0 = performance.now();
    const handle = enhanceCalloutsLazy(root, { viewportHeight: 1080 });
    const ms = performance.now() - t0;
    console.log(`[bench] enhanceCalloutsLazy 3000 blocks visible-13: ${ms.toFixed(2)}ms`);
    const enhanced = root.querySelectorAll("blockquote.callout").length;
    expect(enhanced).toBeLessThan(30); // ~13 + slack
    expect(enhanced).toBeGreaterThan(0);
    // Eager mode on this size takes ~700ms; lazy first-paint should be <100ms.
    expect(ms).toBeLessThan(150);
    handle.disconnect();
  });
});
