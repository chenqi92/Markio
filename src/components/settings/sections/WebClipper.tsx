import { Toggle } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { openExternal } from "@/lib/opener";
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
  const htmlToMd = useSettings((s) => s.clipperHtmlToMd);
  const readability = useSettings((s) => s.clipperReadability);
  const aiSummary = useSettings((s) => s.clipperAiSummary);
  const pdfSnapshot = useSettings((s) => s.clipperPdfSnapshot);
  const setPreference = useSettings((s) => s.setPreference);

  return (
    <>
      <SectionHeader id="clipper" />

      <div className="settings-banner">
        扩展端 → 桌面端的推送通道未接，下方开关已存好；扩展上架后即生效。
      </div>

      <div className="settings-card">
        <div className="settings-card-h">扩展安装</div>
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
        <div className="settings-card-h">
          收藏行为
          <span className="settings-pill-soon">扩展上架后生效</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">HTML → Markdown</div>
            <div className="settings-help">用 turndown 类规则把网页转为 .md，再落到收件箱目录</div>
          </div>
          <Toggle on={htmlToMd} disabled onChange={(v) => setPreference("clipperHtmlToMd", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">Readability 抽取正文</div>
            <div className="settings-help">先用 readability 算法剥掉导航 / 广告 / 评论再保存</div>
          </div>
          <Toggle on={readability} disabled onChange={(v) => setPreference("clipperReadability", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">AI 摘要</div>
            <div className="settings-help">保存时调用当前 AI 提供方生成一句话摘要，写进 frontmatter</div>
          </div>
          <Toggle on={aiSummary} disabled onChange={(v) => setPreference("clipperAiSummary", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">附带 PDF 快照</div>
            <div className="settings-help">在 attachments/ 下额外保留原页 PDF，链接挂在文件 frontmatter</div>
          </div>
          <Toggle on={pdfSnapshot} disabled onChange={(v) => setPreference("clipperPdfSnapshot", v)} />
        </div>
      </div>
    </>
  );
}
