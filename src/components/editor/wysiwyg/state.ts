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

import { StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { anySensitiveRangeFlipped, build, type BuildResult } from "./build";

export const wysiwygField = StateField.define<BuildResult>({
  create(state) {
    return build(state);
  },
  update(prev, tr) {
    // 文档变了 → 必须完整重算（widget 位置 / 内容都可能动）
    if (tr.docChanged) {
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
