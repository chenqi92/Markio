import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../ui/Icon";
import {
  copyHtml,
  copyMarkdown,
  exportHtml,
  exportPdf,
} from "@/lib/export";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";

const ITEMS = [
  {
    id: "pdf",
    icon: "file",
    title: "导出为 PDF…",
    sub: "打开系统打印对话框，选「保存为 PDF」",
    run: async (title: string, source: string) => {
      await exportPdf(title, source);
    },
  },
  {
    id: "html",
    icon: "code",
    title: "导出为 HTML",
    sub: "单文件 · 内嵌样式",
    run: async (title: string, source: string) => {
      await exportHtml(title, source);
    },
  },
  {
    id: "copy-md",
    icon: "copy",
    title: "复制 Markdown",
    sub: "把原始 markdown 文本复制到剪贴板",
    run: async (_title: string, source: string) => {
      await copyMarkdown(source);
    },
  },
  {
    id: "copy-html",
    icon: "link",
    title: "复制为 HTML 片段",
    sub: "粘贴到富文本编辑器保留格式",
    run: async (title: string, source: string) => {
      await copyHtml(title, source);
    },
  },
] satisfies Array<{
  id: string;
  icon: IconName;
  title: string;
  sub: string;
  run: (title: string, source: string) => Promise<void>;
}>;

export function ExportMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tab = useTabs((s) => s.activeTab());
  const setToast = useUI((s) => s.setToast);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  if (!tab) {
    onClose();
    return null;
  }

  const run = async (id: string) => {
    const item = ITEMS.find((i) => i.id === id);
    if (!item) return;
    try {
      await item.run(tab.title, tab.content);
      setToast({
        stage: "done",
        message: id.startsWith("copy") ? "已复制到剪贴板" : "导出完成",
      });
      setTimeout(() => setToast(null), 2000);
    } catch (e) {
      setToast({
        stage: "error",
        message: `导出失败：${(e as Error).message}`,
      });
      setTimeout(() => setToast(null), 2500);
    }
    onClose();
  };

  return (
    <div
      className="new-menu"
      ref={ref}
      style={{ right: 0, left: "auto", width: 260 }}
    >
      <div className="new-menu-h">导出</div>
      {ITEMS.map((it) => (
        <button
          type="button"
          key={it.id}
          className="new-menu-item"
          onClick={() => run(it.id)}
        >
          <span className="ico">
            <Icon name={it.icon} size={14} />
          </span>
          <div className="meta">
            <div className="ttl">{it.title}</div>
            <div className="sub">{it.sub}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
