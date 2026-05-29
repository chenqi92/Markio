/**
 * [[wikilink]] 双向链接 widget。
 *
 * detectWikilinks 是纯函数（接 text + vault files），跟 store 解耦，方便测试。
 * currentVaultFiles 是 build() 调一次的 helper，避免 detector 内部反复
 * useWorkspace.getState() / useVaultIndex.getState()。
 *
 * WikilinkWidget 渲染为 `<a class="cm-md-wikilink" href="#">`，href 是常量
 * (不让用户写的 target 进 href)；点击行为由主文件的 wysiwygMousedown 处理：
 * 解析到 path → 打开目标笔记；未解析 / Alt+点击 → 把光标移到 markdown 源码。
 */

import { EditorView, WidgetType } from "@codemirror/view";

import { openEditPopover } from "./editPopover";
import { parseWikiLinkBody, resolveWikiFile } from "@/lib/wikilinks";
import { useVaultIndex } from "@/stores/vaultIndex";
import { useWorkspace } from "@/stores/workspace";

export interface WikilinkInfo {
  from: number;
  to: number;
  display: string;
  target: string;
  heading?: string;
  /** Resolved file path if the target was found in the vault, else undefined. */
  path?: string;
}

/** Vault files for the currently-active workspace, or undefined if none open.
 *  Pulled once per build() so detectWikilinks doesn't repeatedly poke the stores. */
export type VaultFiles = ReturnType<typeof currentVaultFiles>;

export function currentVaultFiles() {
  const ws = useWorkspace.getState();
  const activeWs = ws.workspaces.find((w) => w.id === ws.activeId);
  return activeWs
    ? useVaultIndex.getState().index[activeWs.path]?.files
    : undefined;
}

export function detectWikilinks(text: string, files: VaultFiles): WikilinkInfo[] {
  // 跳过 fenced code (``` ... ```) 与 inline code (`...`)：代码块里的
  // [[Foo]] 是字面字符，不应被替换成 widget（比如解释 wikilink 语法的文档）。
  const out: WikilinkInfo[] = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const c = text[i];
    // fenced code block at line start
    if (
      c === "`" &&
      text[i + 1] === "`" &&
      text[i + 2] === "`" &&
      (i === 0 || text[i - 1] === "\n")
    ) {
      const close = text.indexOf("\n```", i + 3);
      if (close < 0) break;
      const afterFence = text.indexOf("\n", close + 1);
      i = afterFence < 0 ? len : afterFence + 1;
      continue;
    }
    // inline code
    if (c === "`") {
      const close = text.indexOf("`", i + 1);
      if (close < 0) {
        i++;
        continue;
      }
      i = close + 1;
      continue;
    }
    // [[ ... ]] (single-line, body length capped at 200)
    if (c === "[" && text[i + 1] === "[") {
      const close = text.indexOf("]]", i + 2);
      if (close < 0) {
        i++;
        continue;
      }
      const body = text.slice(i + 2, close);
      if (body.length === 0 || body.length > 200 || body.includes("\n")) {
        i++;
        continue;
      }
      const parts = parseWikiLinkBody(body);
      if (parts) {
        const resolved = resolveWikiFile(files, parts.target);
        out.push({
          from: i,
          to: close + 2,
          display: parts.display,
          target: parts.target,
          heading: parts.heading,
          path: resolved?.path,
        });
        i = close + 2;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out;
}

export class WikilinkWidget extends WidgetType {
  constructor(private readonly info: WikilinkInfo) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof WikilinkWidget &&
      other.info.target === this.info.target &&
      other.info.display === this.info.display &&
      other.info.heading === this.info.heading &&
      other.info.path === this.info.path
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-wikilink-wrap";
    wrap.dataset.sourceLength = String(this.info.to - this.info.from);

    const a = document.createElement("a");
    a.className = "cm-md-wikilink";
    a.href = "#";
    a.textContent = this.info.display;
    if (this.info.path) {
      a.dataset.path = this.info.path;
      a.title = `打开 ${this.info.target}${this.info.heading ? "#" + this.info.heading : ""}`;
    } else {
      a.classList.add("missing");
      a.title = `未找到笔记：${this.info.target}`;
    }
    if (this.info.heading) a.dataset.heading = this.info.heading;
    wrap.append(a);

    // 单击仍走主插件的「打开笔记」；悬浮出现的小按钮才进编辑浮层
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-md-wikilink-edit";
    edit.textContent = "✎";
    edit.title = "编辑链接（目标 / 显示文本）";
    edit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    edit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWikilinkEditor(view, wrap, this.info);
    });
    wrap.append(edit);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function wikilinkRangeFromHost(
  view: EditorView,
  host: HTMLElement,
): { from: number; to: number } | null {
  const from = view.posAtDOM(host);
  const len = Number(host.dataset.sourceLength);
  if (from == null || !Number.isFinite(len) || len <= 0) return null;
  const to = Math.min(view.state.doc.length, from + len);
  return to > from ? { from, to } : null;
}

function openWikilinkEditor(view: EditorView, host: HTMLElement, info: WikilinkInfo) {
  const range = wikilinkRangeFromHost(view, host);
  if (!range) return;
  openEditPopover(
    view,
    host,
    [
      { key: "target", label: "目标", value: info.target, placeholder: "笔记名" },
      { key: "display", label: "显示", value: info.display, placeholder: "显示文本（可空）" },
    ],
    (v) => {
      const target = v.target!.trim();
      if (!target) return;
      const head = info.heading ? `#${info.heading}` : "";
      const disp = v.display!.trim();
      const body = disp && disp !== target ? `${target}${head}|${disp}` : `${target}${head}`;
      const next = `[[${body}]]`;
      const current = view.state.doc.sliceString(range.from, range.to);
      if (next !== current) {
        view.dispatch({
          changes: { from: range.from, to: range.to, insert: next },
          userEvent: "input",
        });
      }
    },
  );
}
