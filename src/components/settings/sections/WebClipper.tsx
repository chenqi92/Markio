import { useEffect, useState } from "react";
import { Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useUI } from "@/stores/ui";
import { openExternal } from "@/lib/opener";
import { writeText } from "@/lib/clipboard";
import { api } from "@/lib/api";
import { SectionHeader } from "../_shared";

const CLIPPER_BROWSERS: ReadonlyArray<{
  id: string;
  label: string;
  sub: string;
  url: string;
}> = [
  {
    id: "chrome",
    label: "Chrome",
    sub: "Chrome Web Store",
    url: "https://chrome.google.com/webstore",
  },
  {
    id: "edge",
    label: "Edge",
    sub: "Edge Add-ons",
    url: "https://microsoftedge.microsoft.com/addons",
  },
  {
    id: "firefox",
    label: "Firefox",
    sub: "Mozilla Add-ons",
    url: "https://addons.mozilla.org",
  },
  {
    id: "safari",
    label: "Safari",
    sub: "App Store · Safari Extensions",
    url: "https://apps.apple.com",
  },
];

export function WebClipper() {
  const enabled = useSettings((s) => s.clipperEnabled);
  const htmlToMd = useSettings((s) => s.clipperHtmlToMd);
  const readability = useSettings((s) => s.clipperReadability);
  const aiSummary = useSettings((s) => s.clipperAiSummary);
  const pdfSnapshot = useSettings((s) => s.clipperPdfSnapshot);
  const setPreference = useSettings((s) => s.setPreference);
  const setToast = useUI((s) => s.setToast);

  const [status, setStatus] = useState<{ port: number | null; token: string | null }>({
    port: null,
    token: null,
  });

  // 本地接收端启动后回读端口 + token（启用后展示给浏览器扩展粘贴）
  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .clipperStatus()
        .then((s) => {
          if (alive) setStatus({ port: s.port, token: s.token });
        })
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled]);

  const endpoint = status.port ? `http://127.0.0.1:${status.port}` : "（接收端启动中…）";

  const copy = async (text: string, label: string) => {
    try {
      await writeText(text);
      setToast({ stage: "done", message: `${label}已复制` });
      setTimeout(() => setToast(null), 1600);
    } catch {
      setToast({ stage: "error", message: "复制失败" });
      setTimeout(() => setToast(null), 1600);
    }
  };

  return (
    <>
      <SectionHeader id="clipper" />

      <div className="settings-card">
        <div className="settings-card-h">总开关</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">启用网页收藏</div>
            <div className="settings-help">
              开启后 markio 在本机启动一个仅 127.0.0.1 的接收端，浏览器扩展把网页推送进来转 Markdown 落到当前仓库的 Clipped/ 目录
            </div>
          </div>
          <Toggle on={enabled} onChange={(v) => setPreference("clipperEnabled", v)} />
        </div>
      </div>

      {enabled && (
        <div className="settings-card">
          <div className="settings-card-h">接收端（粘贴到浏览器扩展）</div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">地址</div>
              <div
                className="settings-help"
                style={{ fontFamily: "var(--font-mono)", userSelect: "all" }}
              >
                {endpoint}
              </div>
            </div>
            <button
              className="settings-btn"
              disabled={!status.port}
              onClick={() => void copy(endpoint, "地址")}
            >
              复制
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">访问 token</div>
              <div
                className="settings-help"
                style={{
                  fontFamily: "var(--font-mono)",
                  userSelect: "all",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 320,
                }}
              >
                {status.token ?? "（启动中…）"}
              </div>
            </div>
            <button
              className="settings-btn"
              disabled={!status.token}
              onClick={() => status.token && void copy(status.token, "token")}
            >
              复制
            </button>
          </div>
        </div>
      )}

      <div className="settings-card">
        <div className="settings-card-h">浏览器扩展安装</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">开发者模式加载</div>
            <div className="settings-help">
              扩展脚手架在仓库 clipper-extension/ 目录；在浏览器「扩展 → 开发者模式 → 加载已解压」选择该目录，再把上面的地址 + token 填进扩展弹窗
            </div>
          </div>
        </div>
        <div className="clipper-browsers">
          {CLIPPER_BROWSERS.map((b) => (
            <button
              key={b.id}
              type="button"
              className="about-foot-card"
              onClick={() => void openExternal(b.url)}
            >
              <div className="t">{b.label}</div>
              <div className="s">{b.sub}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">收藏行为</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">HTML → Markdown</div>
            <div className="settings-help">把网页 HTML 转成 .md（关闭则原样保留 HTML 代码块）</div>
          </div>
          <Toggle on={htmlToMd} onChange={(v) => setPreference("clipperHtmlToMd", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">Readability 抽取正文</div>
            <div className="settings-help">转换前剥掉导航 / 页脚 / 侧栏 / 脚本，只留正文</div>
          </div>
          <Toggle on={readability} onChange={(v) => setPreference("clipperReadability", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              AI 摘要
              <span className="settings-pill-soon">即将上线</span>
            </div>
            <div className="settings-help">保存时调用当前 AI 提供方生成一句话摘要写进 frontmatter（待接入）</div>
          </div>
          <Toggle on={aiSummary} disabled onChange={(v) => setPreference("clipperAiSummary", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">
              附带 PDF 快照
              <span className="settings-pill-soon">即将上线</span>
            </div>
            <div className="settings-help">额外保留原页 PDF（需无头渲染，待接入）</div>
          </div>
          <Toggle on={pdfSnapshot} disabled onChange={(v) => setPreference("clipperPdfSnapshot", v)} />
        </div>
      </div>
    </>
  );
}
