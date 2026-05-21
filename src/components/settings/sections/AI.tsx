import { useEffect, useState } from "react";
import { Toggle, Slider, SelectBtn } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { api } from "@/lib/api";
import * as aiCache from "@/lib/aiCache";
import {
  AI_PROVIDERS,
  getProvider,
  getProviderDefaults,
  type AIProviderId,
} from "@/lib/ai-providers";
import { AIModelPicker } from "../AIModelPicker";
import { SectionHeader, CardTitle, LabelWithTip, HelpTip } from "./_shared";

export function AI() {
  const provider = useSettings((s) => s.aiProvider);
  const keyConfigured = useSettings((s) => s.aiKeyConfigured);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const providerConfigs = useSettings((s) => s.aiProviderConfigs);
  const setAi = useSettings((s) => s.setAi);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const confirmDialog = useDialog((s) => s.confirm);

  const def = getProvider(provider);

  // endpoint / model 改动时落到当前 provider 的槽位，下次切回来还在。
  const persistProviderField = (patch: { endpoint?: string; model?: string }) => {
    const cur = providerConfigs[provider] ?? {};
    setAi({
      aiProviderConfigs: {
        ...providerConfigs,
        [provider]: { ...cur, ...patch },
      },
    });
  };

  const switchProvider = (id: AIProviderId) => {
    if (id === provider) return;
    const saved = providerConfigs[id] ?? {};
    const defaults = getProviderDefaults(id);
    setAi({
      aiProvider: id,
      aiEndpoint: saved.endpoint ?? defaults.endpoint,
      aiModel: saved.model ?? defaults.model,
    });
    setTestResult(null);
  };

  // 切换 provider 时刷新"是否已配"
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await api.secretHas(`ai:${provider}`);
        if (!cancelled) setAi({ aiKeyConfigured: has });
      } catch {
        if (!cancelled) setAi({ aiKeyConfigured: false });
      }
    })();
    setKeyDraft("");
    return () => {
      cancelled = true;
    };
  }, [provider, setAi]);

  const saveKey = async () => {
    if (!keyDraft) return;
    setSavingKey(true);
    try {
      await api.secretSet(`ai:${provider}`, keyDraft);
      setAi({ aiKeyConfigured: true });
      setKeyDraft("");
      setTestResult("✓ 已存入系统钥匙串");
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    const ok = await confirmDialog({
      title: "清除 API Key？",
      message: `清除 ${provider} 的 API Key？`,
      confirmLabel: "清除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete(`ai:${provider}`);
      setAi({ aiKeyConfigured: false });
      setKeyDraft("");
      setTestResult("已清除");
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.aiChat({
        provider,
        endpoint: endpoint || undefined,
        model,
        maxTokens: 32,
        temperature: 0,
        messages: [{ role: "user", content: "ping" }],
      });
      setTestResult(`✓ ${r.text.slice(0, 80) || "已连接"}`);
    } catch (e) {
      setTestResult(`✗ ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  const useCurrentFile = useSettings((s) => s.aiUseCurrentFile);
  const useWorkspace = useSettings((s) => s.aiUseWorkspace);

  return (
    <>
      <SectionHeader id="ai" />

      <div className="settings-card">
        <CardTitle tip="这些开关会决定发送给 AI 的上下文范围。">
          回答时的上下文
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="系统 prompt 会包含当前打开 Markdown 的前 6000 字。">
              把当前笔记发给 AI
            </LabelWithTip>
          </div>
          <Toggle
            on={useCurrentFile}
            onChange={(v) => setAi({ aiUseCurrentFile: v })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="提问时先在仓库中查找关键词，并把命中片段发给当前 AI 提供方。">
              用仓库做关键词检索
            </LabelWithTip>
          </div>
          <Toggle
            on={useWorkspace}
            onChange={(v) => setAi({ aiUseWorkspace: v })}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">API 提供方</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">当前提供方</div>
            <div className="settings-help">
              切换后会自动恢复该提供方上次的 endpoint / 模型（API Key 始终独立保存）
            </div>
          </div>
          <SelectBtn
            value={provider}
            options={AI_PROVIDERS.map((p) => {
              const saved = providerConfigs[p.id]?.model || providerConfigs[p.id]?.endpoint;
              return {
                value: p.id,
                label: `${p.name} · ${p.sub}${saved && provider !== p.id ? " · 已记住" : ""}`,
              };
            })}
            onChange={(v) => switchProvider(v)}
            minMenuWidth={320}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">
          {def?.name ?? provider} 配置
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label settings-label-with-tip">
              <span>
                API Key
                {keyConfigured && (
                  <span
                    style={{
                      marginLeft: 8,
                      padding: "1px 6px",
                      fontSize: 10,
                      fontWeight: 600,
                      background: "var(--accent-glow)",
                      color: "var(--accent)",
                      borderRadius: 4,
                    }}
                  >
                    已配置
                  </span>
                )}
              </span>
              <HelpTip text="非 Ollama 提供方的 Key 存入系统钥匙串；前端不会持久化明文。" />
            </div>
            <div className="settings-help">
              {def?.keyOptional
                ? "本地服务可留空"
                : keyConfigured
                ? "已存储"
                : "未配置"}
            </div>
          </div>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={() => {
              if (keyDraft) saveKey();
            }}
            placeholder={
              keyConfigured ? "已保存 · 输入新值替换" : def?.keyPlaceholder ?? "API Key"
            }
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 220,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="留空会使用当前提供方的默认地址。">
              Endpoint
            </LabelWithTip>
          </div>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => {
              const v = e.target.value;
              setAi({ aiEndpoint: v });
              persistProviderField({ endpoint: v });
            }}
            placeholder={def?.defaultEndpoint || "https://..."}
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 260,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">默认模型</div>
          </div>
          {def ? (
            <AIModelPicker
              provider={def}
              endpoint={endpoint}
              value={model}
              onChange={(v) => {
                setAi({ aiModel: v });
                persistProviderField({ model: v });
              }}
            />
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => {
                const v = e.target.value;
                setAi({ aiModel: v });
                persistProviderField({ model: v });
              }}
              placeholder="model id"
              style={{
                padding: "5px 10px",
                background: "var(--bg-input)",
                border: "0.5px solid var(--border-strong)",
                borderRadius: 6,
                width: 220,
                fontSize: 12,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>
        <div
          className="settings-row"
          style={{ background: "var(--bg-pane-2)" }}
        >
          <div className="settings-row-l">
            <div className="settings-label" style={{ color: "var(--accent)" }}>
              测试连接
            </div>
            <div className="settings-help">
              {testResult ?? "发送一次 ping 请求验证 Key 与 Endpoint"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {keyConfigured && (
              <button
                className="settings-btn"
                onClick={clearKey}
                disabled={savingKey || testing}
              >
                清除 Key
              </button>
            )}
            <button
              className="settings-btn primary"
              onClick={test}
              disabled={testing || savingKey}
            >
              {testing ? "测试中…" : "测试"}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-h">高级参数</div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">温度 (Temperature)</div>
            <div className="settings-help">
              {temperature.toFixed(2)} · 越高越发散
            </div>
          </div>
          <Slider
            value={Math.round(temperature * 100)}
            min={0}
            max={150}
            onChange={(v) => setAi({ aiTemperature: v / 100 })}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">最大输出 tokens</div>
          </div>
          <input
            type="number"
            min={256}
            max={32000}
            value={maxTokens}
            onChange={(e) =>
              setAi({ aiMaxTokens: Math.max(256, Math.min(32000, Number(e.target.value) || 4096)) })
            }
            style={{
              padding: "5px 10px",
              background: "var(--bg-input)",
              border: "0.5px solid var(--border-strong)",
              borderRadius: 6,
              width: 120,
              fontSize: 12,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
      </div>
      <AICacheCard />
    </>
  );
}

function AICacheCard() {
  const enabled = useSettings((s) => s.aiCacheEnabled);
  const setPreference = useSettings((s) => s.setPreference);
  const [cleared, setCleared] = useState(false);
  return (
    <div className="settings-card">
      <div className="settings-card-h">响应缓存</div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">启用缓存（仅本次会话）</div>
          <div className="settings-help">
            完全相同的 prompt + 模型 + RAG 上下文不重发请求，秒回上次结果。改一字即重发。
            重启清空。默认关，避免破坏"重新生成"语义。
          </div>
        </div>
        <Toggle on={enabled} onChange={(v) => setPreference("aiCacheEnabled", v)} />
      </div>
      <div className="settings-row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <span className="settings-help">
          {cleared ? "已清空" : `当前缓存：${aiCache.size()} 条`}
        </span>
        <button
          className="settings-btn"
          onClick={() => {
            aiCache.clear();
            setCleared(true);
            window.setTimeout(() => setCleared(false), 1500);
          }}
        >
          清空缓存
        </button>
      </div>
    </div>
  );
}
