import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./ui/Icon";
import { useSettings } from "@/stores/settings";
import { isDarkTheme } from "@/themes";
import { api, parseError, pickDirectory, pickFile } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useDialog } from "@/stores/dialog";
import { displayPath } from "@/lib/utils";
import { readText } from "@/lib/clipboard";
import { NOTE_TEMPLATES, type NoteTemplate } from "@/lib/note-templates";
import { openExternal } from "@/lib/opener";

export function Welcome() {
  const { t } = useTranslation();
  const theme = useSettings((s) => s.theme);
  const dark = isDarkTheme(theme);
  const addWorkspace = useWorkspace((s) => s.addWorkspace);
  const workspaces = useWorkspace((s) => s.workspaces);
  const activeWs = useWorkspace((s) => s.activeWorkspace());
  const setActive = useWorkspace((s) => s.setActive);
  const loadDir = useWorkspace((s) => s.loadDir);
  const openPath = useTabs((s) => s.openPath);
  const openFile = useTabs((s) => s.openFile);
  const setToast = useUI((s) => s.setToast);
  const promptDialog = useDialog((s) => s.prompt);
  const confirmDialog = useDialog((s) => s.confirm);
  const [logoErr, setLogoErr] = useState(false);

  useEffect(() => setLogoErr(false), [dark]);

  const flash = (stage: "done" | "error", msg: string, ms = stage === "error" ? 2500 : 1500) => {
    setToast({ stage, message: msg });
    window.setTimeout(() => setToast(null), ms);
  };

  // 模板入口：没仓库先拉一个；有仓库就直接在根目录 createNew + openFile。
  const applyTemplate = async (tpl: NoteTemplate) => {
    let ws = activeWs;
    if (!ws) {
      const ok = await confirmDialog({
        title: "需要先选一个仓库",
        message: "新建笔记会落到当前仓库根目录。要选一个文件夹吗？",
        confirmLabel: "选文件夹",
      });
      if (!ok) return;
      const dir = await pickDirectory();
      if (!dir) return;
      await addWorkspace(dir);
      ws = useWorkspace.getState().activeWorkspace();
      if (!ws) return;
    }
    const now = new Date();
    const defaultName = tpl.defaultName(now);
    const name = await promptDialog({
      title: tpl.isFolder ? "新建文件夹" : `从模板新建：${tpl.title}`,
      message: tpl.isFolder ? "文件夹名称。" : "文件名；未含 .md 时会自动追加。",
      defaultValue: defaultName,
      confirmLabel: tpl.isFolder ? "创建" : "新建",
    });
    if (!name) return;

    if (tpl.isFolder) {
      const target = `${ws.path}/${name}`;
      try {
        await api.mkdir(target);
        await loadDir(ws.id, ws.path);
        flash("done", "已创建文件夹");
      } catch (e) {
        flash("error", `创建失败：${(e as Error).message}`);
      }
      return;
    }

    const fname = name.endsWith(".md") ? name : `${name}.md`;
    const target = `${ws.path}/${fname}`;
    try {
      const content = tpl.build(now);
      await api.createNew(target, content || `# ${fname.replace(/\.md$/i, "")}\n\n`);
      await loadDir(ws.id, ws.path);
      await openFile(ws.id, target);
    } catch (e) {
      const pe = parseError(e);
      if (pe.code === "ALREADY_EXISTS") {
        flash("error", "同名文件已存在");
      } else {
        flash("error", `创建失败：${pe.message}`);
      }
    }
  };

  // 3 种导入：从文件 / 剪贴板 / URL 抓取。URL 抓取由于 CSP 限制（connect-src 'self'）
  // 无法直接 fetch 任意 URL，先打开浏览器让用户复制内容回来再走剪贴板路径。
  const importFromFile = async () => {
    const f = await pickFile([
      { name: "Markdown / Text", extensions: ["md", "markdown", "mdown", "mkd", "txt"] },
    ]);
    if (f) await openPath(f);
  };

  const importFromClipboard = async () => {
    let text: string;
    try {
      text = await readText();
    } catch {
      flash("error", "读取剪贴板失败");
      return;
    }
    if (!text.trim()) {
      flash("error", "剪贴板为空");
      return;
    }
    let ws = activeWs;
    if (!ws) {
      const ok = await confirmDialog({
        title: "需要先选一个仓库",
        message: "剪贴板内容会落到当前仓库根目录。要选一个文件夹吗？",
        confirmLabel: "选文件夹",
      });
      if (!ok) return;
      const dir = await pickDirectory();
      if (!dir) return;
      await addWorkspace(dir);
      ws = useWorkspace.getState().activeWorkspace();
      if (!ws) return;
    }
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const fname = `clipboard-${ts}.md`;
    const target = `${ws.path}/${fname}`;
    try {
      await api.createNew(target, text);
      await loadDir(ws.id, ws.path);
      await openFile(ws.id, target);
      flash("done", `已从剪贴板创建 ${fname}`);
    } catch (e) {
      flash("error", `创建失败：${(e as Error).message}`);
    }
  };

  const importFromUrl = async () => {
    const url = await promptDialog({
      title: "从 URL 抓取",
      message:
        "桌面端 CSP 限制下无法直接抓取任意网页。点确定会在浏览器打开该地址，复制正文后再用「从剪贴板」导入。",
      defaultValue: "https://",
      confirmLabel: "在浏览器打开",
    });
    if (!url || url === "https://") return;
    try {
      await openExternal(url);
    } catch (e) {
      flash("error", `打开失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
      {logoErr ? (
        <div className="logo">m</div>
      ) : (
        <img
          src={dark ? "/brand/icon-dark-512.png" : "/brand/icon-light-512.png"}
          alt="markio"
          onError={() => setLogoErr(true)}
          style={{ width: 96, height: 96 }}
        />
      )}
      <h1>markio</h1>
      <p>{t("welcome.tagline")}</p>
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          onClick={async () => {
            const dir = await pickDirectory();
            if (dir) await addWorkspace(dir);
          }}
        >
          {t("welcome.openFolder")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            const f = await pickFile([
              { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
            ]);
            if (f) await openPath(f);
          }}
        >
          {t("welcome.openFile")}
        </button>
      </div>

      {/* 模板网格 */}
      <div className="welcome-section">
        <div className="welcome-section-h">{t("welcome.fromTemplates")}</div>
        <div className="welcome-tpl-grid">
          {NOTE_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              className="welcome-tpl"
              onClick={() => void applyTemplate(tpl)}
              title={tpl.sub}
            >
              <span className="welcome-tpl-ico">
                <Icon name={tpl.icon} size={16} />
              </span>
              <div className="welcome-tpl-tt">
                <div className="t">{tpl.title}</div>
                <div className="s">{tpl.sub}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 3 种导入 */}
      <div className="welcome-section">
        <div className="welcome-section-h">{t("welcome.import")}</div>
        <div className="welcome-import-row">
          <button type="button" className="welcome-import" onClick={() => void importFromFile()}>
            <span className="welcome-tpl-ico"><Icon name="file" size={16} /></span>
            <div className="welcome-tpl-tt">
              <div className="t">{t("welcome.importFile")}</div>
              <div className="s">{t("welcome.importFileSub")}</div>
            </div>
          </button>
          <button
            type="button"
            className="welcome-import"
            onClick={() => void importFromClipboard()}
          >
            <span className="welcome-tpl-ico"><Icon name="copy" size={16} /></span>
            <div className="welcome-tpl-tt">
              <div className="t">{t("welcome.importClip")}</div>
              <div className="s">{t("welcome.importClipSub")}</div>
            </div>
          </button>
          <button
            type="button"
            className="welcome-import"
            onClick={() => void importFromUrl()}
          >
            <span className="welcome-tpl-ico"><Icon name="link" size={16} /></span>
            <div className="welcome-tpl-tt">
              <div className="t">{t("welcome.importUrl")}</div>
              <div className="s">{t("welcome.importUrlSub")}</div>
            </div>
          </button>
        </div>
      </div>

      {/* 最近仓库 */}
      {workspaces.length > 0 && (
        <div className="welcome-section">
          <div className="welcome-section-h">{t("welcome.recent")}</div>
          <div className="welcome-recents">
            {workspaces.slice(0, 5).map((w) => (
              <button
                type="button"
                key={w.id}
                onClick={() => setActive(w.id)}
                className="welcome-recent"
              >
                <div
                  className="welcome-recent-av"
                  style={{
                    background: `linear-gradient(135deg, ${w.color}, var(--accent-2))`,
                  }}
                >
                  {w.initial}
                </div>
                <div className="welcome-recent-tt">
                  <div className="t">{w.name}</div>
                  <div className="s">{displayPath(w.path)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="welcome-foot">
        {t("welcome.browseAll")}{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void openExternal("https://github.com/chenqi92/Markio/tree/main/src/lib/note-templates.ts");
          }}
        >
          {t("welcome.viewMore")}
        </a>
      </div>
      </div>
    </div>
  );
}
