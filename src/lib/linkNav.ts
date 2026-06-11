// markdown 行内链接的统一跳转逻辑，被预览（Preview）与所见即所得编辑器
// （wysiwyg mousedown）共用，避免两处行为漂移。
//
// 关键约束：在 Tauri WebView 里，任何相对路径 <a> 的默认导航都会把整个 SPA
// 跳走（变成空白 / 重新加载）。所以两个界面都不能让默认导航发生——点击全部
// 走这里路由：外链交给系统浏览器，库内文件用标签页打开，锚点交回各自界面。

import { openExternal } from "./opener";
import { pathContains, resolveRelativePath } from "./utils";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { useUI } from "@/stores/ui";

export type LinkKind = "empty" | "anchor" | "external" | "file";

/** 判断一个 href 属于哪类链接。 */
export function classifyHref(href: string): LinkKind {
  if (!href) return "empty";
  if (href.startsWith("#")) return "anchor";
  // 带 scheme（http(s):、mailto:、tel:、ftp: 等）→ 外部协议
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return "external";
  // 其余视为相对 / 绝对的本地文件路径
  return "file";
}

/**
 * 跳转一个非锚点链接：
 *  - external → 交给系统默认 app（openExternal 仅放行 http(s)/mailto/tel）
 *  - file     → 相对当前笔记解析成绝对路径，用标签页打开
 *
 * 锚点（#...）与空链接返回 false，由调用方按界面自行处理（DOM 滚动 / 编辑器滚动）。
 */
export async function navigateMarkdownLink(
  href: string,
  baseFilePath: string | undefined,
): Promise<boolean> {
  const kind = classifyHref(href);
  if (kind === "external") {
    await openExternal(href);
    return true;
  }
  if (kind === "file") {
    if (!baseFilePath) return true;
    const abs = resolveRelativePath(baseFilePath, href);
    if (abs) {
      // 安全：链接点击只允许跳到已注册仓库内的文件。否则 [x](../../../etc/passwd)
      // 或绝对路径会读取仓库外任意文件，并经 openPath 自动注册其父目录提权。
      const inVault = useWorkspace
        .getState()
        .workspaces.some((w) => pathContains(w.path, abs));
      if (inVault) {
        await useTabs.getState().openPath(abs);
      } else {
        useUI
          .getState()
          .setToast({ stage: "error", message: "链接指向仓库外的文件，已阻止打开" });
      }
    }
    return true;
  }
  return false;
}
