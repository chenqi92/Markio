import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api, parseError, pickDirectory, pickFile } from "@/lib/api";

interface Template {
  id: string;
  icon: IconName;
  title: string;
  sub: string;
  build: () => { name: string; content: string };
}

function todayName() {
  const d = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

const TEMPLATES: Template[] = [
  {
    id: "blank",
    icon: "note",
    title: "空白笔记",
    sub: "⌘N",
    build: () => ({ name: "未命名.md", content: "# 未命名\n\n" }),
  },
  {
    id: "daily",
    icon: "calendar",
    title: "今日日记",
    sub: todayName(),
    build: () => {
      const date = todayName();
      return {
        name: `${date}.md`,
        content: `# ${date}\n\n## 今天\n\n- \n\n## 备忘\n\n- \n`,
      };
    },
  },
  {
    id: "meeting",
    icon: "target",
    title: "会议纪要",
    sub: "来自模板",
    build: () => ({
      name: `会议-${todayName()}.md`,
      content: `# 会议纪要 · ${todayName()}\n\n**与会者**：\n\n## 议程\n\n1. \n\n## 决议\n\n- [ ] \n\n## 行动项\n\n- [ ] @ \n`,
    }),
  },
  {
    id: "book",
    icon: "book",
    title: "读书笔记",
    sub: "来自模板",
    build: () => ({
      name: "读书笔记.md",
      content: `# 书名\n\n*作者*\n\n## 核心观点\n\n- \n\n## 摘抄\n\n> \n\n## 我的延伸\n\n`,
    }),
  },
];

export function NewMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const ws = useWorkspace((s) => s.activeWorkspace());
  const setToast = useUI((s) => s.setToast);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const create = async (t: Template) => {
    if (!ws) {
      setToast({ stage: "error", message: "请先打开一个仓库" });
      setTimeout(() => setToast(null), 2000);
      onClose();
      return;
    }
    const { name, content } = t.build();
    const userName = window.prompt("文件名（自动追加 .md）", name.replace(/\.md$/i, ""));
    if (!userName) {
      onClose();
      return;
    }
    const fname = userName.endsWith(".md") ? userName : `${userName}.md`;
    const path = `${ws.path}/${fname}`;
    try {
      await api.createNew(path, content);
      await useWorkspace.getState().refreshTree(ws.id);
      await useTabs.getState().openFile(ws.id, path);
      setToast({ stage: "done", message: "已创建" });
      setTimeout(() => setToast(null), 1500);
    } catch (e) {
      const err = parseError(e);
      if (err.code === "ALREADY_EXISTS") {
        const reuse = window.confirm(`${fname} 已存在。打开它？`);
        if (reuse) await useTabs.getState().openFile(ws.id, path);
      } else {
        setToast({ stage: "error", message: `创建失败：${err.message}` });
        setTimeout(() => setToast(null), 2500);
      }
    }
    onClose();
  };

  const importFile = async () => {
    const f = await pickFile([
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
    ]);
    if (f) await useTabs.getState().openPath(f);
    onClose();
  };

  const openFolder = async () => {
    const d = await pickDirectory();
    if (d) await useWorkspace.getState().addWorkspace(d);
    onClose();
  };

  return (
    <div className="new-menu" ref={ref}>
      <div className="new-menu-h">新建</div>
      {TEMPLATES.map((t) => (
        <button
          type="button"
          key={t.id}
          className="new-menu-item"
          onClick={() => create(t)}
        >
          <span className="ico">
            <Icon name={t.icon} size={14} />
          </span>
          <div className="meta">
            <div className="ttl">{t.title}</div>
            <div className="sub">{t.sub}</div>
          </div>
        </button>
      ))}
      <div className="new-menu-sep" />
      <button type="button" className="new-menu-item" onClick={importFile}>
        <span className="ico">
          <Icon name="file" size={14} />
        </span>
        <div className="meta">
          <div className="ttl">从文件导入…</div>
          <div className="sub">.md / .markdown</div>
        </div>
      </button>
      <button type="button" className="new-menu-item" onClick={openFolder}>
        <span className="ico">
          <Icon name="folder" size={14} />
        </span>
        <div className="meta">
          <div className="ttl">打开文件夹…</div>
          <div className="sub">⌘⇧O</div>
        </div>
      </button>
    </div>
  );
}
