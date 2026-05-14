import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { api } from "@/lib/api";
import { renderMermaidIn } from "@/lib/mermaid";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useSettings } from "@/stores/settings";
import { insertBlock } from "@/lib/editor-bridge";
import { crumbSegments } from "@/lib/utils";
import type { FileEntry } from "@/types";

interface Props {
  /** wiki 名（不带 .md） */
  name: string;
  onClose: () => void;
}

/** 在文件树里递归找首个匹配文件名的 .md（不区分大小写、忽略扩展名） */
function findByName(tree: FileEntry | undefined, name: string): FileEntry | null {
  if (!tree) return null;
  const target = name.toLowerCase();
  const stack: FileEntry[] = [tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (!n.isDir) {
      const base = n.name.replace(/\.(md|markdown|mdown|mkd)$/i, "").toLowerCase();
      if (base === target) return n;
    }
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return null;
}

/**
 * AI 工作区右侧引用预览面板。
 * - 接 wiki 名，从当前 workspace 文件树里找首个匹配的 .md，渲染预览
 * - 找不到时显示空态 + 提示
 * - 底部两个动作：插入到当前编辑器 / 在主编辑器中打开
 */
export function AIPreview({ name, onClose }: Props) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tree = useWorkspace((s) => s.activeTree());
  const setToast = useUI((s) => s.setToast);
  const openFile = useTabs((s) => s.openFile);
  const openAi = useUI((s) => s.openAi);
  const fontSize = useSettings((s) => s.fontSize);

  const [html, setHtml] = useState<string>("");
  const [path, setPath] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    setPath(null);
    const node = findByName(tree, name);
    if (!node) return;
    setPath(node.path);
    api
      .open(node.path)
      .then((o) => api.renderMarkdown(o.content))
      .then((r) => {
        if (cancelled) return;
        setHtml(r.html);
      })
      .catch(() => {
        if (cancelled) return;
        setHtml(
          `<pre style="font-size: 12px; color: var(--text-3);">读取失败：${node.path}</pre>`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [name, tree]);

  useEffect(() => {
    if (!ref.current) return;
    renderMermaidIn(ref.current).catch(() => undefined);
  }, [html]);

  const openInEditor = async () => {
    if (!ws || !path) return;
    await openFile(ws.id, path);
    openAi(false);
    onClose();
  };

  const insertCitation = async () => {
    if (!path) return;
    const stem = name;
    insertBlock(`[[${stem}]] `);
    setToast({ stage: "done", message: "已在当前笔记插入引用" });
    setTimeout(() => setToast(null), 1500);
  };

  if (!path) {
    return (
      <aside className="ai-preview">
        <div className="ai-preview-h">
          <div className="ai-preview-h-l">
            <span className="badge">未找到</span>
            <span className="ttl">{name}</span>
          </div>
          <div className="ai-preview-h-r">
            <button type="button" onClick={onClose} title="关闭">
              <Icon name="x" size={12} />
            </button>
          </div>
        </div>
        <div className="ai-preview-empty">
          <div className="icn">
            <Icon name="archive" size={28} />
          </div>
          <div>
            仓库内没有名为
            <br />
            <strong style={{ color: "var(--text)" }}>{name}</strong>
            <br />
            的笔记
          </div>
        </div>
      </aside>
    );
  }

  const segs = ws ? crumbSegments(ws.path, path) : [];

  return (
    <aside className="ai-preview">
      <div className="ai-preview-h">
        <div className="ai-preview-h-l">
          <span className="badge">跳转预览</span>
          <span className="ttl">{segs[segs.length - 1] ?? name}</span>
        </div>
        <div className="ai-preview-h-r">
          <button type="button" onClick={openInEditor} title="在主编辑器中打开">
            <Icon name="external" size={12} />
          </button>
          <button type="button" onClick={onClose} title="关闭">
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>
      {segs.length > 0 && (
        <div className="ai-preview-crumb">
          {segs.slice(0, -1).map((s, i) => (
            <span key={i}>
              <span>{s}</span>
              <span style={{ opacity: 0.4, margin: "0 4px" }}>›</span>
            </span>
          ))}
          <span style={{ color: "var(--text)", fontWeight: 600 }}>
            {segs[segs.length - 1]}
          </span>
        </div>
      )}
      <div className="ai-preview-body scroll">
        <div
          ref={ref}
          className="preview"
          style={{ fontSize: Math.max(13, fontSize - 2) }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      <div className="ai-preview-footer">
        <button
          type="button"
          className="ai-preview-action"
          onClick={insertCitation}
          title="在当前编辑器光标处插入 [[名字]]"
        >
          <Icon name="link" size={12} />
          <span>插入引用</span>
        </button>
        <button
          type="button"
          className="ai-preview-action"
          onClick={openInEditor}
          title="退出 AI、在主编辑器中打开此笔记"
        >
          <Icon name="external" size={12} />
          <span>在主编辑器中打开</span>
        </button>
      </div>
    </aside>
  );
}
