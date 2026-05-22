import type { RefObject } from "react";
import { Icon } from "../ui/Icon";
import { ToolbarMenuPortal } from "./ToolbarMenuPortal";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useDialog } from "@/stores/dialog";
import { api, parseError, pickDirectory, pickFile } from "@/lib/api";
import { shortcutText } from "@/lib/shortcuts";
import { NOTE_TEMPLATES, type NoteTemplate } from "@/lib/note-templates";

export function NewMenu({
  anchorRef,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const setToast = useUI((s) => s.setToast);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);

  const toast = (stage: "done" | "error", message: string, ttl = 2000) => {
    setToast({ stage, message });
    setTimeout(() => setToast(null), ttl);
  };

  const create = async (t: NoteTemplate) => {
    if (!ws) {
      toast("error", "请先打开一个仓库");
      onClose();
      return;
    }
    const now = new Date();
    const defaultName = t.defaultName(now);
    const userName = await promptDialog({
      title: t.title,
      message: t.isFolder
        ? "输入文件夹名"
        : "输入文件名；未包含 .md 时会自动追加。",
      defaultValue: defaultName,
      confirmLabel: "创建",
    });
    if (!userName) {
      onClose();
      return;
    }

    if (t.isFolder) {
      const path = `${ws.path}/${userName}`;
      try {
        await api.mkdir(path);
        await useWorkspace.getState().refreshTree(ws.id);
        toast("done", "已创建文件夹", 1500);
      } catch (e) {
        toast("error", `创建失败：${parseError(e).message}`, 2500);
      }
      onClose();
      return;
    }

    const fname = userName.endsWith(".md") ? userName : `${userName}.md`;
    const path = `${ws.path}/${fname}`;
    const content = t.build(now);
    try {
      await api.createNew(path, content);
      await useWorkspace.getState().refreshTree(ws.id);
      await useTabs.getState().openFile(ws.id, path);
      toast("done", "已创建", 1500);
    } catch (e) {
      const err = parseError(e);
      if (err.code === "ALREADY_EXISTS") {
        const reuse = await confirmDialog({
          title: "文件已存在",
          message: `${fname} 已存在。要打开它吗？`,
          confirmLabel: "打开",
        });
        if (reuse) await useTabs.getState().openFile(ws.id, path);
      } else {
        toast("error", `创建失败：${err.message}`, 2500);
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

  const importClipboard = async () => {
    if (!ws) {
      toast("error", "请先打开一个仓库");
      onClose();
      return;
    }
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast("error", "读取剪贴板失败（需授权）", 2500);
      onClose();
      return;
    }
    if (!text.trim()) {
      toast("error", "剪贴板为空");
      onClose();
      return;
    }
    const userName = await promptDialog({
      title: "从剪贴板新建",
      message: "输入文件名；未包含 .md 时会自动追加。",
      defaultValue: "剪贴板",
      confirmLabel: "创建",
    });
    if (!userName) {
      onClose();
      return;
    }
    const fname = userName.endsWith(".md") ? userName : `${userName}.md`;
    const path = `${ws.path}/${fname}`;
    try {
      await api.createNew(path, text);
      await useWorkspace.getState().refreshTree(ws.id);
      await useTabs.getState().openFile(ws.id, path);
      toast("done", "已创建", 1500);
    } catch (e) {
      const err = parseError(e);
      if (err.code === "ALREADY_EXISTS") {
        toast("error", `${fname} 已存在`, 2500);
      } else {
        toast("error", `创建失败：${err.message}`, 2500);
      }
    }
    onClose();
  };

  const importUrl = async () => {
    toast("error", "URL 抓取功能即将上线", 2000);
    onClose();
  };

  const openFolder = async () => {
    const d = await pickDirectory();
    if (d) await useWorkspace.getState().addWorkspace(d);
    onClose();
  };

  return (
    <ToolbarMenuPortal
      anchorRef={anchorRef}
      onClose={onClose}
      width={520}
      className="new-menu-wide"
    >
      <div className="new-menu-h">从模板新建</div>
      <div className="new-menu-grid">
        {NOTE_TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.id}
            className="new-tpl-card"
            onClick={() => create(t)}
          >
            <span className="new-tpl-ico">
              <Icon name={t.icon} size={14} />
            </span>
            <div className="new-tpl-meta">
              <div className="t">{t.title}</div>
              <div className="s">{t.sub}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="new-menu-sep" />
      <div className="new-menu-h">导入</div>
      <button type="button" className="new-menu-item" onClick={importFile}>
        <span className="ico">
          <Icon name="download" size={14} />
        </span>
        <div className="meta">
          <div className="ttl">从文件导入…</div>
          <div className="sub">.md / .markdown · 多选</div>
        </div>
      </button>
      <button type="button" className="new-menu-item" onClick={importClipboard}>
        <span className="ico">
          <Icon name="copy" size={14} />
        </span>
        <div className="meta">
          <div className="ttl">从剪贴板新建</div>
          <div className="sub">将剪贴板文本写入新文件</div>
        </div>
      </button>
      <button type="button" className="new-menu-item" onClick={importUrl}>
        <span className="ico">
          <Icon name="external" size={14} />
        </span>
        <div className="meta">
          <div className="ttl">从 URL 抓取</div>
          <div className="sub">敬请期待</div>
        </div>
      </button>
      <div className="new-menu-sep" />
      <button type="button" className="new-menu-item" onClick={openFolder}>
        <span className="ico">
          <Icon name="folder" size={14} />
        </span>
        <div className="meta">
          <div className="ttl">打开文件夹…</div>
          <div className="sub">{shortcutText("⌘⇧O")}</div>
        </div>
      </button>
    </ToolbarMenuPortal>
  );
}
