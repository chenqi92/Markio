import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/Icon";
import { useSettings } from "@/stores/settings";
import { useAISessions } from "@/stores/aiSessions";
import { useTabs } from "@/stores/tabs";
import { useDialog } from "@/stores/dialog";
import { getProvider } from "@/lib/ai-providers";

interface Props {
  attachedCount: number;
  onClose: () => void;
}

/** 估算 token 数。混合中英时按 3.5 chars/token 折算够用了——实际计费走服务端。 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/** 简单按 provider 给一个粗略的上下文窗口大小（max input tokens）；
 *  仅用于显示进度条，不影响实际请求。 */
const PROVIDER_CONTEXT_WINDOW: Record<string, number> = {
  anthropic: 200_000,
  openai: 128_000,
  google: 1_000_000,
  deepseek: 64_000,
  nvidia: 128_000,
  xai: 256_000,
  groq: 128_000,
  openrouter: 200_000,
  siliconflow: 128_000,
  zhipu: 128_000,
  dashscope: 128_000,
  moonshot: 128_000,
  mistral: 128_000,
  together: 128_000,
  ollama: 32_000,
  custom: 64_000,
};

/** 输入 token 的粗估单价（USD / 1M tokens）；做"够用的成本提示"。 */
const PROVIDER_PRICE_PER_M: Record<string, number> = {
  anthropic: 3.0, // sonnet 类
  openai: 2.5, // gpt-4o
  google: 1.25, // gemini-2.5-pro
  deepseek: 0.3, // deepseek-chat
  nvidia: 0.5,
  xai: 5.0,
  groq: 0.5,
  openrouter: 3.0,
  siliconflow: 0.4,
  zhipu: 0.8,
  dashscope: 1.0,
  moonshot: 1.5,
  mistral: 2.0,
  together: 0.6,
  ollama: 0,
  custom: 0,
};

export function AIContextDrawer({ attachedCount, onClose }: Props) {
  const { t } = useTranslation();
  const provider = useSettings((s) => s.aiProvider);
  const model = useSettings((s) => s.aiModel);
  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWorkspaceCtx = useSettings((s) => s.aiUseWorkspace);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const setAi = useSettings((s) => s.setAi);
  const activeSession = useAISessions((s) => s.activeSession());
  const deleteSession = useAISessions((s) => s.deleteSession);
  const activeTab = useTabs((s) => s.activeTab());
  const confirmDialog = useDialog((s) => s.confirm);

  const def = getProvider(provider);
  const contextWindow = PROVIDER_CONTEXT_WINDOW[provider] ?? 32_000;
  const pricePerM = PROVIDER_PRICE_PER_M[provider] ?? 0;

  const breakdown = useMemo(() => {
    const sysPart = useCurrentFile && activeTab
      ? Math.min(6000, activeTab.content.length)
      : 0;
    const sysTokens = estimateTokens("x".repeat(sysPart));
    const histTokens = (activeSession?.messages ?? []).reduce(
      (sum, m) => sum + estimateTokens(m.text),
      0,
    );
    const wsTokens = useWorkspaceCtx ? 4000 : 0; // 检索回填的粗略上限
    const total = sysTokens + histTokens + wsTokens;
    return { sysTokens, histTokens, wsTokens, total };
  }, [activeSession, activeTab, useCurrentFile, useWorkspaceCtx]);

  const pct = Math.min(100, Math.round((breakdown.total / contextWindow) * 100));
  const danger = pct >= 85;
  const warn = pct >= 60 && !danger;

  const estCost = (breakdown.total / 1_000_000) * pricePerM;

  const clearConversation = async () => {
    if (!activeSession) return;
    const ok = await confirmDialog({
      title: t("aiContext.clearConfirmTitle"),
      message: t("aiContext.clearConfirmMessage", { count: activeSession.messages.length }),
      confirmLabel: t("aiContext.clear"),
      danger: true,
    });
    if (!ok) return;
    deleteSession(activeSession.id);
  };

  return (
    <div className="ai-ctx" role="complementary" aria-label={t("aiContext.title")}>
      <div className="ai-ctx-h">
        <div className="ai-ctx-t">{t("aiContext.title")}</div>
        <button type="button" className="ai-ctx-x" onClick={onClose} title={t("aiContext.close")}>
          <Icon name="x" size={11} />
        </button>
      </div>

      <div className="ai-ctx-body">
        <section>
          <div className="ai-ctx-sec-h">{t("aiContext.secUsage")}</div>
          <div className="ai-ctx-meter">
            <div
              className={
                "ai-ctx-meter-bar" + (danger ? " danger" : warn ? " warn" : "")
              }
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="ai-ctx-meter-l">
            <span className="num">{breakdown.total.toLocaleString()}</span>
            <span className="dim"> / {contextWindow.toLocaleString()}</span>
            <span className="dim"> · {pct}%</span>
          </div>
          <div className="ai-ctx-bk">
            <div>
              <span className="dot sys" /> {t("aiContext.breakdownSys")}
              <span className="r">{breakdown.sysTokens.toLocaleString()}</span>
            </div>
            <div>
              <span className="dot ws" /> {t("aiContext.breakdownWs")}
              <span className="r">{breakdown.wsTokens.toLocaleString()}</span>
            </div>
            <div>
              <span className="dot hist" /> {t("aiContext.breakdownHist")}
              <span className="r">{breakdown.histTokens.toLocaleString()}</span>
            </div>
          </div>
        </section>

        <section>
          <div className="ai-ctx-sec-h">{t("aiContext.secCost")}</div>
          <div className="ai-ctx-cost">
            {pricePerM > 0 ? (
              <>
                <span className="num">${estCost.toFixed(4)}</span>
                <span className="dim"> · ${pricePerM}/1M · {def?.name ?? provider}</span>
              </>
            ) : (
              <span className="dim">{t("aiContext.costLocal")}</span>
            )}
          </div>
          <div className="ai-ctx-model">{model}</div>
        </section>

        <section>
          <div className="ai-ctx-sec-h">{t("aiContext.secSources")}</div>
          <label className="ai-ctx-tog">
            <input
              type="checkbox"
              checked={useCurrentFile}
              onChange={(e) => setAi({ aiUseCurrentFile: e.target.checked })}
            />
            <div>
              <div className="t">{t("aiContext.currentNoteLabel")}</div>
              <div className="s">
                {activeTab
                  ? t("aiContext.currentNoteChars", {
                      title: activeTab.title,
                      chars: Math.min(6000, activeTab.content.length),
                    })
                  : t("aiContext.currentNoteEmpty")}
              </div>
            </div>
          </label>
          <label className="ai-ctx-tog">
            <input
              type="checkbox"
              checked={useWorkspaceCtx}
              onChange={(e) => setAi({ aiUseWorkspace: e.target.checked })}
            />
            <div>
              <div className="t">{t("aiContext.workspaceLabel")}</div>
              <div className="s">{t("aiContext.workspaceSub")}</div>
            </div>
          </label>
          <div className="ai-ctx-attach">
            <div className="t">{t("aiContext.attachedLabel")}</div>
            <div className="s">
              {attachedCount > 0
                ? t("aiContext.attachedCount", { count: attachedCount })
                : t("aiContext.attachedEmpty")}
            </div>
          </div>
        </section>

        <section>
          <div className="ai-ctx-sec-h">{t("aiContext.secMaxTokens")}</div>
          <input
            type="number"
            min={256}
            max={32000}
            value={maxTokens}
            onChange={(e) =>
              setAi({
                aiMaxTokens: Math.max(256, Math.min(32000, Number(e.target.value) || 4096)),
              })
            }
            className="ai-ctx-max"
          />
        </section>

        <section>
          <button
            type="button"
            className="ai-ctx-clear"
            onClick={() => void clearConversation()}
            disabled={!activeSession || (activeSession.messages.length ?? 0) === 0}
          >
            <Icon name="trash" size={12} />
            <span>{t("aiContext.clear")}</span>
          </button>
        </section>
      </div>
    </div>
  );
}
