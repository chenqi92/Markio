import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { api, parseError } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useUI } from "@/stores/ui";

type Target = "inbox" | "today";

function dailyPath(workspace: string): string {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${workspace}/Daily/${key}.md`;
}

function inboxPath(workspace: string): string {
  return `${workspace}/Inbox.md`;
}

async function appendToFile(path: string, body: string): Promise<void> {
  // 试读现有文件；如果不存在就新建。读到后追加时间戳分隔块。
  let baseline = "";
  let mtime: number | undefined;
  try {
    const opened = await api.open(path);
    baseline = opened.content;
    mtime = opened.sig.mtime;
  } catch {
    // 文件不存在 → 用 createNew 建一个空壳，再读回 mtime
    try {
      const sig = await api.createNew(path, "");
      mtime = sig.mtime;
    } catch (e) {
      const err = parseError(e);
      if (err.code !== "ALREADY_EXISTS") throw e;
      const opened = await api.open(path);
      baseline = opened.content;
      mtime = opened.sig.mtime;
    }
  }
  const ts = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const block = `## ${ts}\n\n${body.trim()}\n`;
  const next = baseline.endsWith("\n") || baseline === ""
    ? baseline + (baseline === "" ? "" : "\n") + block
    : baseline + "\n\n" + block;
  await api.save(path, next, mtime);
}

export function QuickCapture({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const setToast = useUI((s) => s.setToast);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>("today");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const targetMeta = useMemo(() => {
    if (!ws) return { today: { path: "—" }, inbox: { path: "—" } };
    return {
      today: { path: dailyPath(ws.path) },
      inbox: { path: inboxPath(ws.path) },
    };
  }, [ws?.path]);

  const save = async () => {
    if (!ws) {
      setErr("请先选择一个工作仓库");
      return;
    }
    if (!text.trim()) {
      onClose();
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const path =
        target === "today" ? dailyPath(ws.path) : inboxPath(ws.path);
      await appendToFile(path, text);
      setToast({ stage: "done", message: "已捕获到笔记" });
      setTimeout(() => setToast(null), 1500);
      onClose();
    } catch (e) {
      setErr(parseError(e).message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const t = window.setTimeout(() => taRef.current?.focus(), 30);
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", k);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", k);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, text]);

  const now = new Date();
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    now.getDay()
  ];
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} · ${weekday}`;

  return (
    <div className="qc-scrim" onClick={onClose}>
      <div
        className="qc2-window"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="快速捕获"
      >
        <div className="qc2-top">
          <div className="qc2-bolt-wrap">
            <span className="qc2-bolt" aria-hidden>⚡</span>
            <span className="qc2-bolt-pulse" aria-hidden />
          </div>
          <div className="qc2-title">快速捕获</div>
          <div className="qc2-time">{timeLabel}</div>
          <span style={{ flex: 1 }} />
          <div className="qc2-target-segment">
            <button
              type="button"
              className={"qc2-tseg" + (target === "today" ? " active" : "")}
              onClick={() => setTarget("today")}
            >
              <span aria-hidden>📅</span>
              <span>今日 Daily</span>
            </button>
            <button
              type="button"
              className={"qc2-tseg" + (target === "inbox" ? " active" : "")}
              onClick={() => setTarget("inbox")}
            >
              <span aria-hidden>📥</span>
              <span>Inbox</span>
            </button>
          </div>
          <button
            type="button"
            className="qc2-close"
            onClick={onClose}
            title="关闭"
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="qc2-target-hint">
          <span aria-hidden>↳</span>
          <span>将追加到</span>
          <span className="qc2-path">{targetMeta[target].path}</span>
        </div>

        <div className="qc2-edit">
          <textarea
            ref={taRef}
            placeholder={"此刻在想什么…\n\n[[ wiki · # 标签 · @ 提及"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {err && (
          <div
            style={{
              padding: "0 20px 8px",
              fontSize: 12,
              color: "#ff453a",
            }}
          >
            {err}
          </div>
        )}

        <div className="qc2-foot">
          <span className="qc2-meta">
            <span>
              <b>{text.length}</b> 字符
            </span>
            <span>
              <b>{text.split("\n").length}</b> 行
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <div className="qc2-actions">
            <button
              type="button"
              className="qc2-btn-ghost"
              onClick={onClose}
              disabled={saving}
            >
              取消 <kbd>esc</kbd>
            </button>
            <button
              type="button"
              className="qc2-btn-primary"
              onClick={() => void save()}
              disabled={saving || !ws}
            >
              {saving ? "保存中…" : "保存"} <kbd>⌘↩</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
