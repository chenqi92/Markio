/**
 * EditorView mousedown handler — 处理 widget 点击行为。
 *
 * 用 EditorView.domEventHandlers 而非 ViewPlugin，因为只需要 view 引用、
 * 不需要 plugin state。每种 widget 的 closest selector 触发对应行为：
 *
 *  - 数学公式：把光标移到公式源码起点（下次 build 自动还原为源码视图）
 *  - wikilink：解析到 path → 打开目标笔记；Alt 点击或未解析 → 移光标到 [[
 *  - 图片：移光标到 ![ 起点
 *  - mermaid / dot / chart：移光标到 fenced code 第二行（源码体）
 *  - 任务复选框：切换 [ ] / [x]
 */

import { EditorView } from "@codemirror/view";

import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";

import { eventElementTarget } from "./util";

export const wysiwygMousedown = EditorView.domEventHandlers({
  mousedown(e, view) {
    const target = eventElementTarget(e);
    if (!target) return;
    // 点击数学公式 widget → 把光标移到公式源码起点，下一次 build 自动还原源码
    const mathHost = target.closest<HTMLElement>(
      ".cm-md-math-inline, .cm-md-math-block",
    );
    if (mathHost) {
      const pos = view.posAtDOM(mathHost);
      if (pos != null) {
        view.dispatch({ selection: { anchor: pos + 1 } });
        view.focus();
        e.preventDefault();
      }
      return;
    }
    // 点击 wikilink widget：
    //   - 已解析 + 普通点击 → 打开目标笔记（与 preview 一致）
    //   - Alt/Option + 点击 OR 未解析 → 把光标移到源码起点编辑
    const wikiHost = target.closest<HTMLElement>(".cm-md-wikilink");
    if (wikiHost) {
      const path = wikiHost.dataset.path;
      if (path && !e.altKey) {
        e.preventDefault();
        void useTabs.getState().openPath(path);
        return;
      }
      const pos = view.posAtDOM(wikiHost);
      if (pos != null) {
        view.dispatch({ selection: { anchor: pos + 2 } }); // 跳过 [[
        view.focus();
        e.preventDefault();
      }
      if (!path) {
        useUI
          .getState()
          .setToast({ stage: "error", message: `未找到笔记：${wikiHost.textContent}` });
        window.setTimeout(() => useUI.getState().setToast(null), 1800);
      }
      return;
    }
    // 点击图片 widget → 把光标移到 markdown 源码起点（!）
    const imgHost = target.closest<HTMLElement>(".cm-md-img-widget");
    if (imgHost) {
      const pos = view.posAtDOM(imgHost);
      if (pos == null) return;
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
      e.preventDefault();
      return;
    }
    // 点击 mermaid / dot / chart widget → 把光标移进 fenced code 第二行（源码体）
    const fencedHost = target.closest<HTMLElement>(".cm-md-fenced-widget");
    if (fencedHost) {
      const pos = view.posAtDOM(fencedHost);
      if (pos != null) {
        const firstLine = view.state.doc.lineAt(pos);
        const innerStart = Math.min(firstLine.to + 1, view.state.doc.length);
        view.dispatch({ selection: { anchor: innerStart } });
        view.focus();
        e.preventDefault();
      }
      return;
    }
    // 点击任务复选框时切换 - [ ] / - [x]
    if (!target.classList?.contains("cm-md-task")) return;
    const pos = view.posAtDOM(target);
    if (pos == null) return;
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const m = text.match(/^(\s*[-*+]\s+\[)([ xX])(\])/);
    if (!m) return;
    const insert = m[2]!.toLowerCase() === "x" ? " " : "x";
    const from = line.from + m[1]!.length;
    const to = from + 1;
    view.dispatch({ changes: { from, to, insert } });
    e.preventDefault();
  },
});
