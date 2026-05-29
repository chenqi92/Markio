import { useEffect, useMemo, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Icon } from "../ui/Icon";
import { useDiagnostics } from "@/stores/diagnostics";
import { openExternal } from "@/lib/opener";
import { writeImage, readImageAsPng } from "@/lib/clipboard";
import { api, isDesktop, pickFile } from "@/lib/api";
import { useOpsLog } from "@/stores/opsLog";

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

// ─── 用户协议 / 隐私 / 开源许可 对话框 ──────────────────────────────
// 之前是直接 openExternal 到 GitHub，离线或仓库地址变动就废了。
// 这里把文本内置进来，跟着应用版本一起走。

const MIT_LICENSE = `MIT License

Copyright (c) ${new Date().getFullYear()} markio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

const PRIVACY_TEXT = `markio 是一款本地优先的 Markdown 阅读与写作应用。你的笔记、工作区、历史快照、本地搜索索引和应用偏好都保存在你的设备或你自己选择的文件夹中。

不收集的数据
markio 不运行广告、跟踪、遥测或分析。markio 没有云账号，开发者不会接收你的笔记、文件、API Key、使用历史或搜索索引。

保存在设备上的数据
应用设置、最近打开的工作区、界面状态、文档历史快照、回收站元数据、本地知识库索引会保存在本机。API Key 与服务凭据尽可能保存在操作系统钥匙串中。

可选第三方服务
只有在你主动配置后才会运行：
· AI 提供方（OpenAI / Anthropic / Google Gemini / DeepSeek / Ollama / 自定义 OpenAI 兼容端点 等）
· 同步与存储（WebDAV / S3 / Dropbox / Google Drive / Git 远端 等）
· 图片上传 / 发布（PicGo / 微信公众号工具 等）
使用这些集成时，你选择发送的内容与凭据会直接发送给对应服务，受该服务自身的条款与隐私政策约束，开发者不会接收或保存。

网络访问
仅在你启用的功能上发生（AI 请求、同步、更新检查、OAuth、图片上传等）。markio 不会因广告或跟踪而联网。

你的控制权
不配置任何网络集成即可完全本地使用。可在设置内随时移除 API Key 与服务凭据，也可以从系统标准存储位置删除本地数据。`;

const OSS_DEPS: { name: string; license: string; sub: string }[] = [
  { name: "React", license: "MIT", sub: "UI 框架" },
  { name: "Tauri", license: "MIT / Apache-2.0", sub: "桌面运行时" },
  { name: "BlockNote", license: "MPL-2.0", sub: "所见即所得编辑器" },
  { name: "CodeMirror 6", license: "MIT", sub: "源码编辑器" },
  { name: "pulldown-cmark", license: "MIT", sub: "Markdown 解析（Rust）" },
  { name: "lezer", license: "MIT", sub: "语法解析" },
  { name: "Zustand", license: "MIT", sub: "状态管理" },
  { name: "i18next", license: "MIT", sub: "国际化" },
  { name: "react-i18next", license: "MIT", sub: "React i18n 绑定" },
  { name: "KaTeX", license: "MIT", sub: "公式渲染" },
  { name: "Mermaid", license: "MIT", sub: "图表渲染" },
  { name: "highlight.js", license: "BSD-3-Clause", sub: "代码高亮" },
  { name: "Vite", license: "MIT", sub: "前端构建" },
  { name: "TypeScript", license: "Apache-2.0", sub: "类型系统" },
];

export function LicenseDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="用户协议" onClose={onClose} width={560}>
      <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 10 }}>
        markio 以 MIT 协议开源，你可以自由使用、修改、分发，但需保留原作者与许可声明。
      </div>
      <pre className="about-notes">{MIT_LICENSE}</pre>
    </ModalShell>
  );
}

export function PrivacyDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="隐私" onClose={onClose} width={560}>
      <div className="about-privacy">{PRIVACY_TEXT}</div>
    </ModalShell>
  );
}

export function OssDialog({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="开源许可" onClose={onClose} width={560}>
      <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 12 }}>
        markio 站在以下开源项目的肩膀上，对所有作者表达谢意。
      </div>
      <div className="about-oss-list">
        {OSS_DEPS.map((d) => (
          <div className="about-oss-item" key={d.name}>
            <div className="about-oss-l">
              <div className="about-oss-name">{d.name}</div>
              <div className="about-oss-sub">{d.sub}</div>
            </div>
            <span className="about-oss-lic">{d.license}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

// ─── 反馈对话框 ────────────────────────────────────────────────────
// 4 类型卡 + textarea + 附加开关 + 截图附件 + 联系邮箱。
// 提交时拼一个 GitHub Issue 预填 URL（遵守 [[feedback_no_central_server]]：不上报到
// SaaS，由用户在 GitHub 上提交）。GitHub URL 不能携带图片附件，所以截图走"复制到
// 剪贴板，让用户在 Issue 编辑器内 ⌘V 粘贴"路径。
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function readImageDimensions(
  dataUrl: string,
): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () =>
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = dataUrl;
  });
}

async function reencodePng(dataUrl: string): Promise<Uint8Array> {
  const img = new window.Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context not available");
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob null"))),
      "image/png",
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

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
  const [attached, setAttached] = useState<{
    pngBytes: Uint8Array;
    dataUrl: string;
    width: number;
    height: number;
    sizeKB: number;
  } | null>(null);
  const [attachBusy, setAttachBusy] = useState<"file" | "clip" | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const diags = useDiagnostics((s) => s.items);
  const ops = useOpsLog((s) => s.items);

  const platform = useMemo(() => {
    if (typeof navigator === "undefined") return "unknown";
    return navigator.userAgent || navigator.platform || "unknown";
  }, []);

  const setAttachedFromPng = async (pngBytes: Uint8Array) => {
    const blob = new Blob([new Uint8Array(pngBytes)], { type: "image/png" });
    const dataUrl = await blobToDataUrl(blob);
    const dims = await readImageDimensions(dataUrl);
    setAttached({
      pngBytes,
      dataUrl,
      width: dims.w,
      height: dims.h,
      sizeKB: Math.round(pngBytes.byteLength / 1024),
    });
    setAttachError(null);
  };

  const pickImageFromFile = async () => {
    if (attachBusy) return;
    setAttachError(null);
    setAttachBusy("file");
    try {
      const path = await pickFile([
        { name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ]);
      if (!path) return;
      const base64 = await api.readFileBase64(path);
      const ext = path.split(".").pop()?.toLowerCase() || "png";
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : "image/png";
      const png = await reencodePng(`data:${mime};base64,${base64}`);
      await setAttachedFromPng(png);
    } catch (e) {
      setAttachError(`读取失败：${(e as Error).message || String(e)}`);
    } finally {
      setAttachBusy(null);
    }
  };

  const readFromClipboard = async () => {
    if (attachBusy) return;
    setAttachError(null);
    setAttachBusy("clip");
    try {
      const png = await readImageAsPng();
      if (!png) {
        setAttachError("剪贴板里没有图片");
        return;
      }
      await setAttachedFromPng(png);
    } catch (e) {
      setAttachError(`读取失败：${(e as Error).message || String(e)}`);
    } finally {
      setAttachBusy(null);
    }
  };

  const clearAttach = () => {
    setAttached(null);
    setAttachError(null);
  };

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
    if (includeOps && ops.length > 0) {
      const recent = ops.slice(0, 50);
      lines.push("");
      lines.push(`**操作记录**（最近 ${recent.length} 步，按倒序）`);
      lines.push("```");
      for (const op of recent) {
        const t = new Date(op.timestamp).toISOString().slice(11, 19);
        const meta = op.meta
          ? Object.entries(op.meta)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")
          : "";
        lines.push(`[${t}] ${op.type}${meta ? " " + meta : ""}`);
      }
      lines.push("```");
    } else if (includeOps) {
      lines.push("");
      lines.push("**操作记录**：当前 buffer 为空（重启或刚清理过）。");
    }
    if (attached) {
      lines.push("");
      lines.push(
        `**截图**：已复制到剪贴板（${attached.width}×${attached.height} · ${attached.sizeKB} KB），请在 Issue 编辑器内 ⌘V / Ctrl+V 粘贴。`,
      );
    }
    return lines.join("\n");
  };

  const submit = async () => {
    const title = `[${kind}] ${(text.trim().split("\n")[0] || "无标题").slice(0, 80)}`;
    const body = buildBody();
    // GitHub Issue URL 无法携带图片附件 —— 在打开浏览器之前把 PNG 写入系统剪贴板，
    // 让用户在 Issue 编辑器内 ⌘V 粘贴。
    if (attached) {
      try {
        await writeImage(attached.pngBytes);
      } catch (e) {
        setAttachError(`截图写入剪贴板失败：${(e as Error).message || String(e)}`);
      }
    }
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
          <div className="about-stage-s">
            {attached
              ? "在浏览器中确认内容；截图已复制到剪贴板，在评论框内按 ⌘V / Ctrl+V 粘贴即可。"
              : "在浏览器中确认内容并点提交。"}
          </div>
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
          <span>
            操作记录（最近 {Math.min(ops.length, 50)} 步动作 · 不含路径 / 文本内容）
          </span>
        </label>
      </div>

      <div
        className="about-fb-row"
        style={{ alignItems: "flex-start", marginTop: 8 }}
      >
        <span className="lbl" style={{ paddingTop: 6 }}>
          截图附件
        </span>
        <div style={{ flex: 1, display: "grid", gap: 6 }}>
          {attached ? (
            <div
              style={{
                display: "flex",
                gap: 10,
                padding: 8,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--surface-2)",
              }}
            >
              <img
                src={attached.dataUrl}
                alt="附图预览"
                style={{
                  width: 96,
                  height: 72,
                  objectFit: "cover",
                  borderRadius: 4,
                  border: "1px solid var(--border)",
                  background: "#fff",
                }}
              />
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  fontSize: 12,
                  color: "var(--text-3)",
                  minWidth: 0,
                }}
              >
                <div>
                  {attached.width} × {attached.height} · {attached.sizeKB} KB
                </div>
                <div style={{ color: "var(--text-3)" }}>
                  提交时会自动复制到剪贴板，请在 GitHub 评论框 ⌘V 粘贴。
                </div>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={clearAttach}
                  style={{ alignSelf: "flex-start" }}
                >
                  移除
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void pickImageFromFile()}
                disabled={attachBusy !== null}
              >
                {attachBusy === "file" ? "读取中…" : "选择图片…"}
              </button>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void readFromClipboard()}
                disabled={attachBusy !== null || !isDesktop()}
                title={
                  isDesktop()
                    ? "把已截好的图从剪贴板粘进来"
                    : "桌面端可用，浏览器预览不支持"
                }
              >
                {attachBusy === "clip" ? "读取中…" : "从剪贴板读取"}
              </button>
            </div>
          )}
          {attachError && (
            <div style={{ fontSize: 12, color: "var(--danger, #d33)" }}>
              {attachError}
            </div>
          )}
        </div>
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
