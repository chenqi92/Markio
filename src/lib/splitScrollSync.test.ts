// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPane,
  resetSplitScrollSync,
  syncPreviewToSource,
  type PaneHandle,
} from "./splitScrollSync";

function makePane(el: HTMLElement): {
  pane: PaneHandle;
  getCallsTopLine: () => number[];
  getCallsRatio: () => number[];
  state: { topLine: number | null; ratio: number };
} {
  const state: { topLine: number | null; ratio: number } = { topLine: 1, ratio: 0.5 };
  const setTopLineCalls: number[] = [];
  const setRatioCalls: number[] = [];
  const pane: PaneHandle = {
    el,
    getTopLine: () => state.topLine,
    setTopLine: (line) => {
      setTopLineCalls.push(line);
      state.topLine = line;
    },
    getRatio: () => state.ratio,
    setRatio: (ratio) => {
      setRatioCalls.push(ratio);
      state.ratio = ratio;
    },
  };
  return {
    pane,
    getCallsTopLine: () => setTopLineCalls,
    getCallsRatio: () => setRatioCalls,
    state,
  };
}

function setScrollBox(
  el: HTMLElement,
  scrollTop: number,
  scrollHeight = 1000,
  clientHeight = 500,
) {
  Object.defineProperty(el, "scrollTop", {
    value: scrollTop,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
}

afterEach(() => {
  resetSplitScrollSync();
  vi.useRealTimers();
});

describe("splitScrollSync", () => {
  it("source scroll forwards top line to preview", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    src.state.topLine = 42.5;
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsTopLine()).toEqual([42.5]);
  });

  it("aligns preview from current source position after both panes register", () => {
    vi.useFakeTimers();
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    src.state.topLine = 33;
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    vi.runAllTimers();
    expect(dst.getCallsTopLine()).toEqual([33]);
  });

  it("can actively re-sync preview after anchors are rebuilt", () => {
    vi.useFakeTimers();
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    vi.runAllTimers();
    src.state.topLine = 44;
    syncPreviewToSource();
    vi.runAllTimers();
    expect(dst.getCallsTopLine()).toContain(44);
  });

  it("listens to additional scroll elements", () => {
    const srcEl = document.createElement("div");
    const srcOuter = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcOuter, srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    src.pane.eventEls = [srcOuter];
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    src.state.topLine = 66;
    srcOuter.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsTopLine()).toContain(66);
  });

  it("preview scroll forwards top line to source", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    dst.state.topLine = 7.25;
    dstEl.dispatchEvent(new Event("scroll"));
    expect(src.getCallsTopLine()).toEqual([7.25]);
  });

  it("falls back to ratio when origin has no anchors", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    src.pane.getTopLine = () => null;
    src.state.ratio = 0.5;
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsRatio()).toEqual([0.5]);
    expect(dst.getCallsTopLine()).toEqual([]);
  });

  it("locks both panes to the bottom edge", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    setScrollBox(srcEl, 499, 1000, 500);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    src.state.topLine = 90;
    src.state.ratio = 0.5;
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsRatio()).toEqual([1]);
    expect(dst.getCallsTopLine()).toEqual([]);
  });

  it("locks both panes to the top edge from the real scroll element", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    setScrollBox(srcEl, 0, 1000, 500);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    src.state.topLine = 12;
    src.state.ratio = 0.5;
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsRatio()).toEqual([0]);
    expect(dst.getCallsTopLine()).toEqual([]);
  });

  it("uses the additional event element for edge detection", () => {
    const srcEl = document.createElement("div");
    const srcOuter = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcOuter, srcEl, dstEl);
    setScrollBox(srcOuter, 0, 1200, 500);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    src.pane.eventEls = [srcOuter];
    src.state.topLine = 66;
    src.state.ratio = 0.5;
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    srcOuter.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsRatio()).toEqual([0]);
    expect(dst.getCallsTopLine()).toEqual([]);
  });

  it("falls back to ratio when destination cannot apply a line target", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    dst.pane.setTopLine = () => false;
    src.state.topLine = 12;
    src.state.ratio = 0.35;
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsRatio()).toEqual([0.35]);
    expect(dst.getCallsTopLine()).toEqual([]);
  });

  it("does not echo: programmatic write on destination doesn't ricochet to origin", () => {
    vi.useFakeTimers();
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    // user scrolls source
    src.state.topLine = 10;
    srcEl.dispatchEvent(new Event("scroll"));
    // pretend dst's scrollTop assignment fires a scroll event on dst
    // immediately after: this is the "echo" we must NOT propagate back to src
    dstEl.dispatchEvent(new Event("scroll"));
    expect(src.getCallsTopLine()).toEqual([]); // src not written by echo
    // after lock window elapses, dst→src works again
    vi.advanceTimersByTime(200);
    dst.state.topLine = 20;
    dstEl.dispatchEvent(new Event("scroll"));
    expect(src.getCallsTopLine()).toEqual([20]);
  });

  it("unregister detaches listener", () => {
    const srcEl = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, dstEl);
    const src = makePane(srcEl);
    const dst = makePane(dstEl);
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    registerPane("source", null);
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsTopLine()).toEqual([]);
    expect(dst.getCallsRatio()).toEqual([]);
  });

  it("re-registering same role swaps the listener cleanly", () => {
    const srcEl = document.createElement("div");
    const srcEl2 = document.createElement("div");
    const dstEl = document.createElement("div");
    document.body.append(srcEl, srcEl2, dstEl);
    const src = makePane(srcEl);
    const src2 = makePane(srcEl2);
    const dst = makePane(dstEl);
    registerPane("source", src.pane);
    registerPane("preview", dst.pane);
    registerPane("source", src2.pane);
    src.state.topLine = 1;
    srcEl.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsTopLine()).toEqual([]); // old src no longer listens
    src2.state.topLine = 99;
    srcEl2.dispatchEvent(new Event("scroll"));
    expect(dst.getCallsTopLine()).toEqual([99]);
  });
});
