/**
 * 把 build() 输出的 DecorationSet 装进 CodeMirror StateField，并通过 provide
 * 把 decorations / atomicRanges 暴露给视图层。
 *
 * 为什么必须 StateField 而不是 ViewPlugin：CodeMirror 禁止 ViewPlugin 提供
 * block 类型的 Decoration.replace（block: true），math display / 表格 /
 * mermaid 等都是 block widget。
 *
 * update 策略：
 *   - docChanged → 完整 rebuild
 *   - selection only → 检查 prev.sensitive 在新旧选区下命中是否翻转；翻转
 *     才 rebuild，否则复用 prev（大文档每次方向键 / 鼠标拖选不再 syntax iterate）
 */

import { StateField, StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

import { anySensitiveRangeFlipped, build, type BuildResult } from "./build";
import { currentVaultFiles } from "./wikilink";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useWorkspace } from "@/stores/workspace";

/** 强制 wysiwyg 重建（vault 索引加载完成 / 仓库文件增删后，需要重算 [[wikilink]] 解析）。 */
export const rebuildWysiwygEffect = StateEffect.define<null>();

export const wysiwygField = StateField.define<BuildResult>({
  create(state) {
    return build(state);
  },
  update(prev, tr) {
    // 文档变了，或收到强制重建 effect（vault 索引变化）→ 必须完整重算
    if (
      tr.docChanged ||
      tr.effects.some((e) => e.is(rebuildWysiwygEffect))
    ) {
      return build(tr.state);
    }
    // 选区变了 → 只在某个"现形/隐藏"边界被跨过时才 rebuild；
    // 否则方向键 / 鼠标拖选 / 简单点击不再触发整文档 syntaxTree iterate。
    if (tr.selection) {
      if (
        anySensitiveRangeFlipped(
          prev.sensitive,
          tr.startState.selection,
          tr.state.selection,
        )
      ) {
        return build(tr.state);
      }
    }
    return prev;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

/** 监听 vault 索引 / 活动仓库变化：当 [[wikilink]] 可解析的文件集变了（典型是
 *  冷启动时索引晚于笔记加载完成），派发重建 effect，否则 wikilink 会一直停在
 *  「未找到」红色态直到用户手动编辑文档才刷新。 */
export const wysiwygVaultSync = ViewPlugin.fromClass(
  class {
    private unsub: Array<() => void> = [];
    private lastFiles: unknown;

    constructor(view: EditorView) {
      this.lastFiles = currentVaultFiles();
      const recompute = () => {
        const files = currentVaultFiles();
        if (files === this.lastFiles) return;
        this.lastFiles = files;
        // 推迟出当前 store 更新 / CM 事务，避免 dispatch-in-update
        queueMicrotask(() => {
          if (!view.dom.isConnected) return;
          view.dispatch({ effects: rebuildWysiwygEffect.of(null) });
        });
      };
      this.unsub.push(useVaultIndex.subscribe(recompute));
      this.unsub.push(useWorkspace.subscribe(recompute));
    }

    destroy() {
      this.unsub.forEach((u) => u());
      this.unsub = [];
    }
  },
);
