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

import { WidgetType } from "@codemirror/view";

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
  // 函数内局部正则：避免共享 /g 全局 RegExp 的 lastIndex 状态（被 worker /
  // microtask / 未来的并发 build 路径污染时会漏匹配）。
  const re = /\[\[([^\]\n]{1,200})\]\]/g;
  const out: WikilinkInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = parseWikiLinkBody(m[1]!);
    if (!parts) continue;
    const resolved = resolveWikiFile(files, parts.target);
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      display: parts.display,
      target: parts.target,
      heading: parts.heading,
      path: resolved?.path,
    });
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
  toDOM(): HTMLElement {
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
    return a;
  }
  ignoreEvent() {
    return false;
  }
}
