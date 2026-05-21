// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPane,
  resetSplitScrollSync,
  type PaneHandle,
} from "./splitScrollSync";

function makePane(el: HTMLElement): {
  pane: PaneHandle;
  getCallsTopLine: () => number[];
  getCallsRatio: () => number[];
  state: { topLine: number | null; ratio: number };
} {
  const state: { topLine: number | null; ratio: number } = { topLine: 1, ratio: 0 };
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
