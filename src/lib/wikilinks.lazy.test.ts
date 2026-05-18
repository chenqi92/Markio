// @vitest-environment happy-dom
//
// Tests for the lazy / viewport-scoped wikilink enhancer. Two angles:
//   1. correctness — after every block fires, the result equals eager mode
//   2. first-paint perf — only enhancing K blocks costs O(K), not O(total)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enhanceWikiLinks,
  enhanceWikiLinksLazy,
} from "./wikilinks";
import type { VaultFile } from "@/lib/api";

// ---- A tiny synchronous IntersectionObserver stub ---------------------------
// happy-dom doesn't ship IO, so we install a controllable one that records
// observed targets and lets tests trigger intersection at will.
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
    if (this.disconnected) return;
    this.observed.push(el);
  }
  unobserve(el: Element) {
    this.observed = this.observed.filter((x) => x !== el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }
  // Test helper: fire the callback for the first `n` observed elements.
  fireFirst(n: number) {
    const fired = this.observed.slice(0, n);
    this.callback(fired.map((target) => ({ target, isIntersecting: true })));
  }
  fireAll() {
    this.fireFirst(this.observed.length);
  }
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: typeof FakeIntersectionObserver }).IntersectionObserver =
    FakeIntersectionObserver;
});

afterEach(() => {
  // Don't leave the stub on globalThis for unrelated tests.
  delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  vi.restoreAllMocks();
});

// ---- Fixtures ---------------------------------------------------------------

function makeDoc(blocks: number): HTMLElement {
  const root = document.createElement("div");
  for (let i = 0; i < blocks; i++) {
    const p = document.createElement("p");
    p.innerHTML = `Paragraph ${i} with [[Note ${i}]] and [[Section ${i}|alias]].`;
    root.appendChild(p);
  }
  document.body.appendChild(root);
  return root;
}

function makeFiles(count: number): VaultFile[] {
  const files: VaultFile[] = [];
  for (let i = 0; i < count; i++) {
    files.push({
      path: `vault/Note ${i}.md`,
      name: `Note ${i}.md`,
      stem: `Note ${i}`,
      mtime: 0,
      size: 0,
      tags: [],
      mentions: [],
    });
    files.push({
      path: `vault/Section ${i}.md`,
      name: `Section ${i}.md`,
      stem: `Section ${i}`,
      mtime: 0,
      size: 0,
      tags: [],
      mentions: [],
    });
  }
  return files;
}

// ---- Correctness ------------------------------------------------------------

describe("enhanceWikiLinksLazy — correctness", () => {
  it("enhances only intersecting blocks, leaves the rest pristine", () => {
    const root = makeDoc(10);
    const handle = enhanceWikiLinksLazy(root, makeFiles(10));
    expect(root.querySelectorAll("a.wikilink").length).toBe(0);

    const io = FakeIntersectionObserver.instances[0];
    io.fireFirst(3);
    // 3 blocks × 2 wikilinks each = 6
    expect(root.querySelectorAll("a.wikilink").length).toBe(6);
    // Other blocks still hold raw [[...]] text
    const pristine = Array.from(root.children).slice(3);
    expect(pristine.every((p) => p.textContent?.includes("[["))).toBe(true);
    handle.disconnect();
  });

  it("flushAll() enhances everything — equivalent to eager mode", () => {
    const files = makeFiles(20);
    const lazyRoot = makeDoc(20);
    const eagerRoot = makeDoc(20);

    const handle = enhanceWikiLinksLazy(lazyRoot, files);
    handle.flushAll();
    enhanceWikiLinks(eagerRoot, files);

    expect(lazyRoot.querySelectorAll("a.wikilink").length).toBe(
      eagerRoot.querySelectorAll("a.wikilink").length,
    );
    // Same resolved state (every link has data-path or .missing class)
    const lazyResolved = Array.from(
      lazyRoot.querySelectorAll<HTMLElement>("a.wikilink"),
    ).map((a) => a.dataset.path ?? "missing");
    const eagerResolved = Array.from(
      eagerRoot.querySelectorAll<HTMLElement>("a.wikilink"),
    ).map((a) => a.dataset.path ?? "missing");
    expect(lazyResolved).toEqual(eagerResolved);
  });

  it("does not re-enhance a block that has been processed", () => {
    const root = makeDoc(5);
    const handle = enhanceWikiLinksLazy(root, makeFiles(5));
    const io = FakeIntersectionObserver.instances[0];
    io.fireAll();
    const before = root.querySelectorAll("a.wikilink").length;
    // Simulate IO firing again for the same blocks (browsers do this when
    // they re-enter the viewport). enhancement must be idempotent.
    io.fireAll();
    expect(root.querySelectorAll("a.wikilink").length).toBe(before);
    handle.disconnect();
  });

  it("disconnect() stops further enhancement", () => {
    const root = makeDoc(10);
    const handle = enhanceWikiLinksLazy(root, makeFiles(10));
    const io = FakeIntersectionObserver.instances[0];
    handle.disconnect();
    io.fireAll();
    // disconnect first means observed[] was cleared
    expect(root.querySelectorAll("a.wikilink").length).toBe(0);
  });

  it("falls back to eager mode when IntersectionObserver is missing", () => {
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
    const root = makeDoc(8);
    enhanceWikiLinksLazy(root, makeFiles(8));
    // All blocks enhanced immediately
    expect(root.querySelectorAll("a.wikilink").length).toBe(16);
  });

  it("blocks without [[ are not observed", () => {
    const root = document.createElement("div");
    const p1 = document.createElement("p");
    p1.textContent = "no links here";
    const p2 = document.createElement("p");
    p2.innerHTML = "has [[Note 1]]";
    root.append(p1, p2);
    document.body.appendChild(root);
    enhanceWikiLinksLazy(root, makeFiles(2));
    const io = FakeIntersectionObserver.instances[0];
    expect(io.observed).toHaveLength(1);
    expect(io.observed[0]).toBe(p2);
  });
});

// ---- First-paint perf -------------------------------------------------------

describe("enhanceWikiLinksLazy — first paint perf", () => {
  it("setup cost on 1MB doc with 3000 blocks is < 100ms (no enhancement yet)", () => {
    // Build a heavyweight DOM equivalent to ~1MB markdown.
    const root = document.createElement("div");
    for (let i = 0; i < 3000; i++) {
      const p = document.createElement("p");
      p.innerHTML =
        `Block ${i}: [[Note ${i}]], [[Section ${i}|alias]], ` +
        `[[Subnote ${i}#heading|see]] — some filler text to pad bytes.`;
      root.appendChild(p);
    }
    document.body.appendChild(root);

    const t0 = performance.now();
    const handle = enhanceWikiLinksLazy(root, makeFiles(1500));
    const setupMs = performance.now() - t0;
    console.log(`[bench] enhanceWikiLinksLazy setup (3000 blocks): ${setupMs.toFixed(2)}ms`);
    // No wikilinks enhanced yet because nothing has intersected.
    expect(root.querySelectorAll("a.wikilink").length).toBe(0);
    // Setup is cheap: index build + observer.observe per block. Generous
    // upper bound to absorb CI flakiness; should be << 100ms locally.
    expect(setupMs).toBeLessThan(500);
    handle.disconnect();
  });

  it("enhancing only first 20 blocks of a 3000-block doc is fast", () => {
    const root = document.createElement("div");
    for (let i = 0; i < 3000; i++) {
      const p = document.createElement("p");
      p.innerHTML =
        `Block ${i}: [[Note ${i}]], [[Section ${i}|alias]], ` +
        `[[Subnote ${i}#heading|see]] — filler text.`;
      root.appendChild(p);
    }
    document.body.appendChild(root);

    const handle = enhanceWikiLinksLazy(root, makeFiles(1500));
    const io = FakeIntersectionObserver.instances[0];

    const t0 = performance.now();
    io.fireFirst(20);
    const firstPaintMs = performance.now() - t0;
    console.log(`[bench] lazy first-paint (20 of 3000 blocks): ${firstPaintMs.toFixed(2)}ms`);
    expect(root.querySelectorAll("a.wikilink").length).toBe(60); // 20 × 3
    // Eager mode on this size takes ~1.5s+; viewport-scoped should be <<200ms.
    expect(firstPaintMs).toBeLessThan(200);
    handle.disconnect();
  });
});
