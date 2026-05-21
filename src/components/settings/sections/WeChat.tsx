import { SelectBtn, type SelectOption } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { SectionHeader } from "./_shared";

const WECHAT_STYLE_OPTIONS = [
  { value: "warmMagazine", label: "暖橘 · 杂志" },
  { value: "cleanTech", label: "清爽 · 科技" },
  { value: "inkClassic", label: "墨色 · 经典" },
  { value: "minimal", label: "极简 · 文章" },
] as const satisfies readonly SelectOption<"warmMagazine" | "cleanTech" | "inkClassic" | "minimal">[];

export function WeChat() {
  const style = useSettings((s) => s.wechatStyle);
  const setPreference = useSettings((s) => s.setPreference);

  return (
    <>
      <SectionHeader id="wechat" />

      <div className="settings-card">
        <div className="settings-card-h">复制默认</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认导出样式</div>
            <div className="settings-help">公众号排版面板会默认选中这套样式。</div>
          </div>
          <SelectBtn
            value={style}
            options={WECHAT_STYLE_OPTIONS}
            onChange={(v) => setPreference("wechatStyle", v)}
          />
        </div>
      </div>
    </>
  );
}
