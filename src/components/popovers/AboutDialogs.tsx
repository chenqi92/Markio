import { useEffect, useMemo, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Icon } from "../ui/Icon";
import { useDiagnostics } from "@/stores/diagnostics";
import { openExternal } from "@/lib/opener";

// ─── 共用：模态外壳 ────────────────────────────────────────────────
function ModalShell({
  title,
  onClose,
  width = 480,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="about-modal"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-modal-h">
          <div className="about-modal-t">{title}</div>
          <button
            type="button"
            className="about-modal-x"
            onClick={onClose}
            title="关闭 (esc)"
            aria-label="关闭"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="about-modal-body">{children}</div>
        {footer && <div className="about-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ─── 检查更新对话框 ────────────────────────────────────────────────
// 4 状态：checking (spinner) → uptodate / available (release notes) → downloading (% 条) → ready (重启)
type UpdateState =
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "downloading"; version: string; progress: number; total: number }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<UpdateState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await check();
        if (cancelled) return;
        if (!u) {
          setState({ kind: "uptodate" });
        } else {
          setState({ kind: "available", version: u.version, notes: u.body });
        }
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startDownload = async () => {
    const cur = state;
    if (cur.kind !== "available") return;
    try {
      const u = await check();
      if (!u) {
        setState({ kind: "uptodate" });
        return;
      }
      let downloaded = 0;
      let contentLength = 0;
      await u.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          contentLength = evt.data.contentLength ?? 0;
          setState({
            kind: "downloading",
            version: u.version,
            progress: 0,
            total: contentLength,
          });
        } else if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          setState({
            kind: "downloading",
            version: u.version,
            progress: downloaded,
            total: contentLength,
          });
        } else if (evt.event === "Finished") {
          setState({ kind: "ready", version: u.version });
        }
      });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  };

  const restartNow = () => {
    relaunch().catch((e) => setState({ kind: "error", message: String(e) }));
  };

  return (
    <ModalShell
      title="检查更新"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="settings-btn" onClick={onClose}>
            关闭
          </button>
          {state.kind === "available" && (
            <button className="settings-btn primary" onClick={startDownload}>
              下载并安装 v{state.version}
            </button>
          )}
          {state.kind === "ready" && (
            <button className="settings-btn primary" onClick={restartNow}>
              立即重启
            </button>
          )}
        </>
      }
    >
      {state.kind === "checking" && (
        <div className="about-stage">
          <div className="about-spin" aria-hidden />
          <div className="about-stage-t">正在检查更新…</div>
          <div className="about-stage-s">连接到发布渠道</div>
        </div>
      )}
      {state.kind === "uptodate" && (
        <div className="about-stage">
          <div className="about-stage-icon ok"><Icon name="check" size={22} /></div>
          <div className="about-stage-t">已是最新版本</div>
          <div className="about-stage-s">没有发现新版本</div>
        </div>
      )}
      {state.kind === "available" && (
        <div>
          <div className="about-ver-row">
            <span className="about-ver-pill">v{state.version}</span>
            <span className="about-ver-tag">可更新</span>
          </div>
          {state.notes ? (
            <pre className="about-notes">{state.notes}</pre>
          ) : (
            <div className="about-stage-s">没有附带发布说明。</div>
          )}
        </div>
      )}
      {state.kind === "downloading" && (
        <div>
          <div className="about-ver-row">
            <span className="about-ver-pill">v{state.version}</span>
            <span className="about-ver-tag">下载中</span>
          </div>
          <div className="about-prog">
            <div
              className="about-prog-bar"
              style={{
                width:
                  state.total > 0
                    ? `${Math.min(100, Math.round((state.progress / state.total) * 100))}%`
                    : "5%",
              }}
            />
          </div>
          <div className="about-stage-s" style={{ marginTop: 8 }}>
            {state.total > 0
              ? `${Math.round((state.progress / 1024 / 1024) * 10) / 10} MB / ${Math.round((state.total / 1024 / 1024) * 10) / 10} MB`
              : "下载中…"}
          </div>
        </div>
      )}
      {state.kind === "ready" && (
        <div className="about-stage">
          <div className="about-stage-icon ok"><Icon name="check" size={22} /></div>
          <div className="about-stage-t">v{state.version} 已就绪</div>
          <div className="about-stage-s">重启后生效</div>
        </div>
      )}
      {state.kind === "error" && (
        <div className="about-stage">
          <div className="about-stage-icon err"><Icon name="alert" size={22} /></div>
          <div className="about-stage-t">检查失败</div>
          <div className="about-stage-s">{state.message}</div>
        </div>
      )}
    </ModalShell>
  );
}

// ─── 发布日志对话框 ────────────────────────────────────────────────
// 数据写死在 src/lib/changelog.ts，发版时改一处。比起跑 GitHub API 更可控且离线可看。
import { CHANGELOG } from "@/lib/changelog";

export function ChangelogDialog({
  currentVersion,
  onClose,
}: {
  currentVersion: string;
  onClose: () => void;
}) {
  return (
    <ModalShell title="发布日志" onClose={onClose} width={560}>
      <div className="about-cl">
        {CHANGELOG.map((entry) => (
          <div className="about-cl-row" key={entry.version}>
            <div className="about-cl-side">
              <div className="about-cl-ver">v{entry.version}</div>
              <div className="about-cl-date">{entry.date}</div>
              {entry.version === currentVersion && (
                <span className="about-cl-tag cur">当前版本</span>
              )}
              {entry.major && (
                <span className="about-cl-tag major">大版本</span>
              )}
            </div>
            <div className="about-cl-main">
              {entry.added && entry.added.length > 0 && (
                <div className="about-cl-section">
                  <span className="about-cl-chip added">新增</span>
                  <ul>
                    {entry.added.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.changed && entry.changed.length > 0 && (
                <div className="about-cl-section">
                  <span className="about-cl-chip changed">改进</span>
                  <ul>
                    {entry.changed.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
              {entry.fixed && entry.fixed.length > 0 && (
                <div className="about-cl-section">
                  <span className="about-cl-chip fixed">修复</span>
                  <ul>
                    {entry.fixed.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

// ─── 反馈对话框 ────────────────────────────────────────────────────
// 4 类型卡 + textarea + 4 附加开关 + 联系邮箱。提交时拼一个 GitHub Issue 预填 URL
// （遵守 [[feedback_no_central_server]]：不上报到 SaaS，由用户在 GitHub 上提交）。
const FEEDBACK_TYPES = [
  { id: "bug", label: "Bug", sub: "复现步骤、报错或异常", icon: "alert" as const },
  { id: "feature", label: "建议", sub: "功能、体验或工作流", icon: "sparkle" as const },
  { id: "praise", label: "表扬", sub: "顺手的功能、想夸的细节", icon: "check" as const },
  { id: "other", label: "其它", sub: "都行 · 没有想好分类", icon: "info" as const },
];

const FEEDBACK_REPO = "chenqi92/Markio";

export function FeedbackDialog({
  appVersion,
  onClose,
}: {
  appVersion: string;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<string>("bug");
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [includeDevice, setIncludeDevice] = useState(true);
  const [includeOps, setIncludeOps] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const diags = useDiagnostics((s) => s.items);

  const platform = useMemo(() => {
    if (typeof navigator === "undefined") return "unknown";
    return navigator.userAgent || navigator.platform || "unknown";
  }, []);

  const buildBody = () => {
    const lines: string[] = [];
    lines.push(text.trim() || "(用户未填写描述)");
    lines.push("\n---\n");
    if (email.trim()) lines.push(`联系邮箱：${email.trim()}`);
    if (includeDevice) {
      lines.push("");
      lines.push("**设备**");
      lines.push("```");
      lines.push(`app: markio v${appVersion}`);
      lines.push(`ua: ${platform}`);
      lines.push("```");
    }
    if (includeLogs && diags.length > 0) {
      lines.push("");
      lines.push("**最近诊断**");
      lines.push("```");
      for (const d of diags.slice(0, 8)) {
        const t = new Date(d.timestamp).toISOString();
        lines.push(`[${d.severity}] ${t} ${d.source} — ${d.message}`);
        if (d.detail) lines.push(`  ${d.detail.slice(0, 200)}`);
      }
      lines.push("```");
    }
    if (includeOps) {
      lines.push("");
      lines.push("**操作记录**：暂未支持自动采集，请在描述中补充复现步骤。");
    }
    return lines.join("\n");
  };

  const submit = async () => {
    const title = `[${kind}] ${(text.trim().split("\n")[0] || "无标题").slice(0, 80)}`;
    const body = buildBody();
    const url =
      `https://github.com/${FEEDBACK_REPO}/issues/new` +
      `?title=${encodeURIComponent(title)}` +
      `&body=${encodeURIComponent(body)}`;
    try {
      await openExternal(url);
      setSubmitted(true);
    } catch {
      // 浏览器打不开时退到 mailto
      const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      try {
        await openExternal(mail);
        setSubmitted(true);
      } catch {
        setSubmitted(true);
      }
    }
  };

  if (submitted) {
    return (
      <ModalShell title="反馈已发送" onClose={onClose} width={420}>
        <div className="about-stage">
          <div className="about-stage-icon ok"><Icon name="check" size={22} /></div>
          <div className="about-stage-t">已为你打开 GitHub 提交页</div>
          <div className="about-stage-s">在浏览器中确认内容并点提交。</div>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title="发送反馈"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="settings-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="settings-btn primary"
            onClick={() => void submit()}
            disabled={!text.trim()}
          >
            打开 GitHub 提交
          </button>
        </>
      }
    >
      <div className="about-fb-kinds">
        {FEEDBACK_TYPES.map((k) => (
          <button
            key={k.id}
            type="button"
            className={"about-fb-kind" + (kind === k.id ? " active" : "")}
            onClick={() => setKind(k.id)}
          >
            <Icon name={k.icon} size={14} />
            <div>
              <div className="t">{k.label}</div>
              <div className="s">{k.sub}</div>
            </div>
          </button>
        ))}
      </div>

      <textarea
        className="about-fb-text"
        placeholder="详细描述：复现步骤 / 期望效果 / 实际结果…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
      />

      <div className="about-fb-attach">
        <label>
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(e) => setIncludeLogs(e.target.checked)}
          />
          <span>诊断日志（最近 8 条 · 仅出错信息，不含文档内容）</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeDevice}
            onChange={(e) => setIncludeDevice(e.target.checked)}
          />
          <span>设备信息（系统 / 浏览器 UA / 应用版本）</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeOps}
            onChange={(e) => setIncludeOps(e.target.checked)}
          />
          <span>操作记录（暂未支持自动采集，请补在描述里）</span>
        </label>
        <label className="dim" title="桌面截图采集后续再做">
          <input type="checkbox" disabled />
          <span>截图附件 · 暂未支持</span>
        </label>
      </div>

      <div className="about-fb-row">
        <span className="lbl">联系邮箱（可选）</span>
        <input
          type="email"
          placeholder="便于跟进；你也可以留空"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="about-fb-note">
        提交时会在浏览器打开 GitHub Issue 预填表单。
        markio 本地不上传任何内容到第三方服务。
      </div>
    </ModalShell>
  );
}
