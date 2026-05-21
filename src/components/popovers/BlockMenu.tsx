import { useTranslation } from "react-i18next";
import { ContextMenu, type CtxItem } from "./ContextMenu";
import {
  currentBlockCharRange,
  deleteCurrentBlock,
  moveBlockDown,
  moveBlockUp,
  replaceRange,
} from "@/lib/editor-bridge";
import { writeText } from "@/lib/clipboard";
import { useUI } from "@/stores/ui";

/**
 * 块级操作菜单（⌘⇧.）：复制 / 上移 / 下移 / 转换为 10 种块 / 删除。
 * 通过既有的 ContextMenu 渲染，行为走 editor-bridge 里的段落区间助手。
 */
export function BlockMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const { t } = useTranslation();
  const setToast = useUI((s) => s.setToast);
  const flash = (msg: string) => {
    setToast({ stage: "done", message: msg });
    window.setTimeout(() => setToast(null), 1200);
  };

  const copyBlock = async () => {
    const r = currentBlockCharRange();
    if (!r) return;
    try {
      await writeText(r.text);
      flash(t("blockMenu.copied"));
    } catch {
      /* ignore */
    }
  };

  /** 把当前段落整段替换为去掉所有行首前缀后再加新前缀的形式。
   *  H1/2/3、引用、列表、待办都靠这个就能互相切换。 */
  const transformWith = (prefix: string) => {
    const r = currentBlockCharRange();
    if (!r) return;
    const lines = r.text.split("\n");
    const stripped = lines.map((ln) =>
      ln.replace(/^(\s*)(?:#{1,6}\s+|>\s+|-\s+\[\s+\]\s+|-\s+\[x\]\s+|[-*+]\s+|\d+\.\s+)?/, "$1"),
    );
    const next = stripped.map((ln) => (ln === "" ? "" : prefix + ln.replace(/^\s+/, ""))).join("\n");
    replaceRange(r.from, r.to, next);
  };

  /** 段落转为整段代码块；保留语言占位。 */
  const transformToCodeBlock = () => {
    const r = currentBlockCharRange();
    if (!r) return;
    replaceRange(r.from, r.to, "```\n" + r.text + "\n```");
  };

  const items: CtxItem[] = [
    { label: t("blockMenu.copy"), icon: "copy", kbd: "⌘C", onClick: () => void copyBlock() },
    { label: t("blockMenu.moveUp"), icon: "chevdown", onClick: () => moveBlockUp() },
    { label: t("blockMenu.moveDown"), icon: "chevdown", onClick: () => moveBlockDown() },
    { sep: true },
    { label: t("blockMenu.toPara"), onClick: () => transformWith("") },
    { label: t("blockMenu.toH1"), onClick: () => transformWith("# ") },
    { label: t("blockMenu.toH2"), onClick: () => transformWith("## ") },
    { label: t("blockMenu.toH3"), onClick: () => transformWith("### ") },
    { label: t("blockMenu.toQuote"), icon: "quote", onClick: () => transformWith("> ") },
    { label: t("blockMenu.toUList"), icon: "list", onClick: () => transformWith("- ") },
    { label: t("blockMenu.toOList"), onClick: () => transformWith("1. ") },
    { label: t("blockMenu.toTask"), icon: "check", onClick: () => transformWith("- [ ] ") },
    { label: t("blockMenu.toCode"), icon: "code", onClick: () => transformToCodeBlock() },
    {
      label: t("blockMenu.insertHr"),
      onClick: () => {
        const r = currentBlockCharRange();
        if (!r) return;
        replaceRange(r.to, r.to, "\n\n---\n");
      },
    },
    { sep: true },
    {
      label: t("blockMenu.delete"),
      icon: "trash",
      danger: true,
      kbd: "⌘⌫",
      onClick: () => deleteCurrentBlock(),
    },
  ];

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}
