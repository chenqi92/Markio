import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, type DriveConfig } from "@/stores/settings";
import { useDialog } from "@/stores/dialog";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { api } from "@/lib/api";
import * as aiCache from "@/lib/aiCache";
import {
  AI_PROVIDERS,
  getProvider,
  getProviderDefaults,
  type AIProviderId,
} from "@/lib/ai-providers";
import {
  isProviderAllowedInCurrentRegion,
} from "@/lib/ai-region-policy";
import { AIModelPicker } from "../AIModelPicker";
import { RagGraphMini } from "../RagGraphMini";
import { CardTitle, HelpTip, LabelWithTip } from "../_shared";
import { SectionHeader } from "../_shared";
import { Toggle, Slider, SelectBtn } from "../../ui/controls";

// 旧 inputStyle 内联（原 Settings.tsx 私有的输入框样式）
const inputStyle: React.CSSProperties = {
  background: "var(--bg-pane-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  color: "var(--text)",
  outline: "none",
  minWidth: 180,
};

const RERANK_SECRET_ACCOUNT = ["rerank", ["co", "here"].join("")].join(":");

export function AI() {
  const provider = useSettings((s) => s.aiProvider);
  const keyConfigured = useSettings((s) => s.aiKeyConfigured);
  const endpoint = useSettings((s) => s.aiEndpoint);
  const model = useSettings((s) => s.aiModel);
  const temperature = useSettings((s) => s.aiTemperature);
  const maxTokens = useSettings((s) => s.aiMaxTokens);
  const providerConfigs = useSettings((s) => s.aiProviderConfigs);
  const aiSources = useSettings((s) => s.aiSources);
  const setAi = useSettings((s) => s.setAi);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const confirmDialog = useDialog((s) => s.confirm);

  const def = getProvider(provider);
  const providerAllowed = isProviderAllowedInCurrentRegion(provider);

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

  // ── AI 源池：同时配置多个源，对话 / embedding / rerank 各自从这里选 ──
  const addSource = (id: AIProviderId) => {
    if (!aiSources.some((s) => s.provider === id)) {
      setAi({
        aiSources: [
          ...aiSources,
          { provider: id, label: getProvider(id)?.name ?? id },
        ],
      });
    }
    switchProvider(id);
  };
  const removeSource = (id: AIProviderId) => {
    const next = aiSources.filter((s) => s.provider !== id);
    if (next.length === 0) return;
    setAi({ aiSources: next });
    if (id === provider) switchProvider(next[0]!.provider);
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
      const inPool = aiSources.some((s) => s.provider === provider);
      setAi({
        aiKeyConfigured: true,
        ...(inPool
          ? {}
          : {
              aiSources: [
                ...aiSources,
                { provider, label: getProvider(provider)?.name ?? provider },
              ],
            }),
      });
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
    if (!providerAllowed) {
      setTestResult("✗ 当前地区不可使用该模型源");
      return;
    }
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
        <div className="settings-card-h">AI 源</div>
        <div className="settings-help" style={{ padding: "0 0 8px" }}>
          可同时配置多个源（每个源的 API Key 独立保存）。点选一个源在下方编辑其
          Key / 端点 / 模型；对话、知识库 embedding、rerank 都从这些源里选。
        </div>
        <div className="ai-source-pool">
          {aiSources.map((src) => (
            <div
              key={src.provider}
              className={
                "ai-source-chip" + (src.provider === provider ? " active" : "")
              }
              onClick={() => switchProvider(src.provider)}
              role="button"
              tabIndex={0}
            >
              <span className="ai-source-name">
                {getProvider(src.provider)?.name ?? src.label}
              </span>
              {aiSources.length > 1 && (
                <button
                  type="button"
                  className="ai-source-del"
                  title="从源池移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSource(src.provider);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <SelectBtn
            value=""
            options={[
              { value: "", label: "+ 添加源…" },
              ...AI_PROVIDERS.filter(
                (p) => !aiSources.some((s) => s.provider === p.id),
              ).map((p) => ({ value: p.id, label: `${p.name} · ${p.sub}` })),
            ]}
            onChange={(v) => {
              if (v) addSource(v as AIProviderId);
            }}
            minMenuWidth={300}
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
        <div className="settings-row settings-row-action">
          <div className="settings-row-l">
            <div className="settings-label">测试连接</div>
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
              disabled={testing || savingKey || !providerAllowed}
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

export function AICacheCard() {
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

// 1x1 透明 PNG，用于 S3 连接测试
const S3_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export function S3Card() {
  const { t } = useTranslation();
  const endpoint = useSettings((s) => s.s3Endpoint);
  const region = useSettings((s) => s.s3Region);
  const bucket = useSettings((s) => s.s3Bucket);
  const accessKeyId = useSettings((s) => s.s3AccessKeyId);
  const publicBaseUrl = useSettings((s) => s.s3PublicBaseUrl);
  const pathStyle = useSettings((s) => s.s3PathStyle);
  const setPreference = useSettings((s) => s.setPreference);
  const [secret, setSecret] = useState("");
  const [stored, setStored] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const testConnection = async () => {
    if (!endpoint || !bucket || !accessKeyId) {
      setMsg({ kind: "err", text: "请先填写 endpoint / bucket / access key" });
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const key = `markio/_probe/${Date.now()}.png`;
      const url = await api.s3PutObject(
        {
          endpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey: "", // 走 keychain
          publicBaseUrl: publicBaseUrl || undefined,
          pathStyle,
        },
        key,
        S3_PROBE_PNG_BASE64,
        "image/png",
      );
      setMsg({ kind: "ok", text: `✓ 连接成功：${url}` });
    } catch (e) {
      setMsg({ kind: "err", text: `✗ ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!endpoint) {
      setStored(false);
      return;
    }
    api.s3HasSecret(endpoint).then(setStored).catch(() => setStored(false));
  }, [endpoint]);

  const save = async () => {
    if (!endpoint) {
      setMsg({ kind: "err", text: "请先填写 endpoint" });
      return;
    }
    try {
      await api.s3SetSecret(endpoint, secret);
      setMsg({ kind: "ok", text: "Secret 已保存到钥匙串" });
      setSecret("");
      setStored(!!secret);
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip={t("settings.picgo.s3Tip")}>
        {t("settings.picgo.s3Card")}
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3EndpointTip")}>Endpoint</LabelWithTip>
        </div>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setPreference("s3Endpoint", e.target.value)}
          placeholder="https://..."
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Region</div>
        </div>
        <input
          type="text"
          value={region}
          onChange={(e) => setPreference("s3Region", e.target.value)}
          placeholder="us-east-1"
          style={{ flex: 1, minWidth: 180 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Bucket</div>
        </div>
        <input
          type="text"
          value={bucket}
          onChange={(e) => setPreference("s3Bucket", e.target.value)}
          placeholder="markio-images"
          style={{ flex: 1, minWidth: 180 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">Access Key ID</div>
        </div>
        <input
          type="text"
          value={accessKeyId}
          onChange={(e) => setPreference("s3AccessKeyId", e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3SecretTip")}>
            {t("settings.picgo.s3Secret")}
          </LabelWithTip>
          <div className="settings-help">
            {stored
              ? t("settings.picgo.s3SecretStored")
              : t("settings.picgo.s3SecretMissing")}
          </div>
        </div>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onBlur={() => {
            if (secret) void save();
          }}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button
          className="settings-btn primary"
          onClick={save}
          disabled={!endpoint || !secret}
        >
          {t("common.save")}
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3PublicBaseTip")}>
            {t("settings.picgo.s3PublicBase")}
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={publicBaseUrl}
          onChange={(e) => setPreference("s3PublicBaseUrl", e.target.value)}
          placeholder="https://cdn.example.com/markio"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3PathStyleTip")}>
            {t("settings.picgo.s3PathStyle")}
          </LabelWithTip>
        </div>
        <Toggle
          on={pathStyle}
          onChange={(v) => setPreference("s3PathStyle", v)}
        />
      </div>
      <div className="settings-row settings-row-action">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3ProbeTip")}>
            {t("settings.picgo.s3Probe")}
          </LabelWithTip>
          <div
            className={
              "settings-help" +
              (msg ? (msg.kind === "err" ? " settings-help-err" : " settings-help-ok") : "")
            }
          >
            {msg?.text ?? t("settings.picgo.s3ProbeTip", { defaultValue: "上传一张 1×1 像素 PNG 验证 endpoint / bucket / 签名是否生效" })}
          </div>
        </div>
        <button
          className="settings-btn primary"
          onClick={testConnection}
          disabled={testing || !endpoint || !bucket || !accessKeyId}
        >
          {testing ? t("settings.picgo.s3Testing") : t("settings.picgo.s3TestBtn")}
        </button>
      </div>
    </div>
  );
}

export function WebDavCard() {
  const baseUrl = useSettings((s) => s.webdavBaseUrl);
  const username = useSettings((s) => s.webdavUsername);
  const remoteDir = useSettings((s) => s.webdavRemoteDir);
  const driveConfigs = useSettings((s) => s.driveConfigs);
  const setPreference = useSettings((s) => s.setPreference);
  const syncCfg: DriveConfig = driveConfigs.webdav ?? { folder: remoteDir || "markio", enabled: false };
  const [password, setPassword] = useState("");
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [connStatus, setConnStatus] = useState<"unknown" | "ok" | "fail">("unknown");
  // baseUrl 改变后旧的测试结果失效
  useEffect(() => {
    setConnStatus("unknown");
  }, [baseUrl]);

  useEffect(() => {
    if (!baseUrl) {
      setStored(false);
      return;
    }
    api.webdavHasPassword(baseUrl).then(setStored).catch(() => setStored(false));
  }, [baseUrl]);

  const auth = () => ({ username, password });

  const updateSyncCfg = (patch: Partial<DriveConfig>) => {
    setPreference("driveConfigs", {
      ...driveConfigs,
      webdav: { ...syncCfg, folder: syncCfg.folder || remoteDir || "markio", ...patch },
    });
  };

  const setSyncEnabled = (enabled: boolean) => {
    if (enabled && !baseUrl) {
      setMsg({ kind: "err", text: "启用同步前请先填写 WebDAV 服务地址" });
      return;
    }
    updateSyncCfg({ enabled });
  };

  const wrap = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: `${label} 完成` });
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async () => {
    if (!baseUrl) {
      setMsg({ kind: "err", text: "请先填写 WebDAV URL" });
      return;
    }
    await wrap("密码保存", async () => {
      await api.webdavSetPassword(baseUrl, password);
      setPassword("");
      setStored(!!password);
    });
  };

  // 统一状态行：off=没填 URL，unknown=没测过，ok=测过且通，fail=测过但失败
  const wdDot: "ok" | "warn" | "off" =
    !baseUrl ? "off" : connStatus === "ok" ? "ok" : connStatus === "fail" ? "warn" : "off";
  const wdSummary = !baseUrl
    ? "未配置 · 在下方填服务地址"
    : connStatus === "ok"
      ? `已连通 · ${baseUrl}`
      : connStatus === "fail"
        ? `连接失败 · ${baseUrl}`
        : `${baseUrl} · 尚未测试`;

  const testConnection = async () => {
    if (!baseUrl) return;
    setBusy("conn");
    setMsg(null);
    try {
      await api.webdavTest(baseUrl, auth());
      setConnStatus("ok");
      setMsg({ kind: "ok", text: "连接成功" });
    } catch (e) {
      setConnStatus("fail");
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip="支持坚果云、TeraCloud、Nextcloud 和自建 WebDAV；密码只保存到系统钥匙串。">
        WebDAV
      </CardTitle>

      <div className="sync-card-status">
        <span className={`upload-dot upload-dot-${wdDot}`} aria-hidden />
        <div className="summary">{wdSummary}</div>
        <button
          className="settings-btn"
          type="button"
          onClick={testConnection}
          disabled={!baseUrl || busy !== null}
        >
          {busy === "conn" ? "测试中…" : "测试连接"}
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="例如 https://dav.jianguoyun.com/dav/">
            服务地址
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setPreference("webdavBaseUrl", e.target.value)}
          placeholder="https://..."
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">用户名</div>
        </div>
        <input
          type="text"
          value={username}
          onChange={(e) => setPreference("webdavUsername", e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="只保存到系统钥匙串，不写入前端持久化设置。">
            应用专用密码
          </LabelWithTip>
          <div className="settings-help">
            {stored ? "已存储" : "未存储"}
          </div>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password / app password"
          style={{ flex: 1, minWidth: 220 }}
        />
        <button
          className="settings-btn"
          disabled={!baseUrl || busy === "密码保存"}
          onClick={savePassword}
        >
          保存
        </button>
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="同步到这个相对路径下；初始化目录会自动创建路径。">
            远端根目录
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={remoteDir}
          onChange={(e) => {
            setPreference("webdavRemoteDir", e.target.value);
            updateSyncCfg({ folder: e.target.value || "markio" });
          }}
          placeholder="markio"
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="开启后，状态栏“立刻同步”和自动同步会把当前仓库与此 WebDAV 目录双向同步。">
            启用 WebDAV 同步
          </LabelWithTip>
          <div className="settings-help">
            同步根目录：{syncCfg.folder || remoteDir || "markio"}
          </div>
        </div>
        <Toggle
          on={syncCfg.enabled && !!baseUrl}
          onChange={setSyncEnabled}
        />
      </div>
      {/* 测试连接已经移到上方 .sync-card-status，这里只留初始化 / 列出 */}
      <div className="settings-action-row">
        <button
          className="settings-btn"
          disabled={!baseUrl || busy !== null}
          onClick={() =>
            wrap("远端目录初始化", () =>
              remoteDir
                ? api.webdavMkcol(baseUrl, auth(), remoteDir)
                : api.webdavTest(baseUrl, auth()),
            )
          }
        >
          初始化目录
        </button>
        <button
          className="settings-btn"
          disabled={!baseUrl || busy !== null}
          onClick={async () => {
            setBusy("list");
            setMsg(null);
            try {
              const items = await api.webdavList(
                baseUrl,
                auth(),
                remoteDir || "/",
              );
              setMsg({
                kind: "ok",
                text: `远端共 ${items.length} 项（${items.filter((i) => i.isDir).length} 目录 / ${items.filter((i) => !i.isDir).length} 文件）`,
              });
            } catch (e) {
              setMsg({ kind: "err", text: String(e) });
            } finally {
              setBusy(null);
            }
          }}
        >
          列举远端
        </button>
      </div>
      {msg && (
        <div
          className="settings-message"
          style={{
            color: msg.kind === "err" ? "#dc2626" : "var(--accent)",
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

export function RepoGraphCard() {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace());
  const [graph, setGraph] = useState<{
    nodes: Array<{ id: number; path: string; inDegree: number; outDegree: number }>;
    edges: Array<{ from: number; to: number }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!activeWorkspace) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api.ragRepoGraph(activeWorkspace.path);
      setGraph(g);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const hubs = useMemoSort(graph?.nodes ?? [], (a, b) => b.inDegree - a.inDegree)
    .slice(0, 10);
  const orphans = (graph?.nodes ?? []).filter(
    (n) => n.inDegree === 0 && n.outDegree === 0,
  );

  return (
    <div className="settings-card">
      <CardTitle tip="基于 [[wiki]] 和 Markdown 链接统计中心笔记与孤立笔记。">
        链接图谱
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <div className="settings-label">
            {graph
              ? `共 ${graph.nodes.length} 笔记 · ${graph.edges.length} 条链接`
              : "未加载"}
          </div>
        </div>
        <button
          className="settings-btn"
          disabled={busy || !activeWorkspace}
          onClick={refresh}
        >
          {busy ? "加载中…" : "重新计算"}
        </button>
      </div>
      {error && (
        <div style={{ color: "#dc2626", fontSize: 12, padding: "4px 16px" }}>
          {error}
        </div>
      )}
      {graph && graph.nodes.length > 0 && (
        <RagGraphMini nodes={graph.nodes} edges={graph.edges} />
      )}
      {graph && hubs.length > 0 && (
        <div style={{ padding: "0 16px 8px" }}>
          <div
            style={{ fontSize: 12, color: "var(--text-3)", margin: "8px 0 4px" }}
          >
            高被引（top {hubs.length}）
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {hubs.map((h) => (
              <li key={h.id}>
                <span style={{ color: "var(--accent)" }}>{h.inDegree}↓</span>{" "}
                {h.path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {graph && orphans.length > 0 && (
        <div style={{ padding: "0 16px 12px" }}>
          <div
            style={{ fontSize: 12, color: "var(--text-3)", margin: "8px 0 4px" }}
          >
            孤立笔记（无 in/out 链接）· {orphans.length} 条
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              maxHeight: 120,
              overflow: "auto",
            }}
          >
            {orphans.slice(0, 30).map((n) => (
              <li key={n.id}>{n.path}</li>
            ))}
            {orphans.length > 30 && <li>… 还有 {orphans.length - 30} 条</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function useMemoSort<T>(items: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return useMemo(() => [...items].sort(cmp), [items, cmp]);
}

export function RerankCard() {
  const enabled = useSettings((s) => s.rerankEnabled);
  const model = useSettings((s) => s.rerankModel);
  const baseUrl = useSettings((s) => s.rerankBaseUrl);
  const setPreference = useSettings((s) => s.setPreference);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirmDialog = useDialog((s) => s.confirm);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await api.secretHas(RERANK_SECRET_ACCOUNT);
        if (!cancelled) setKeyConfigured(has);
      } catch {
        if (!cancelled) setKeyConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setSavingKey(true);
    try {
      await api.secretSet(RERANK_SECRET_ACCOUNT, value);
      setKeyConfigured(true);
      setKeyDraft("");
      setMsg("✓ Reranker API Key 已存入系统钥匙串");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    const ok = await confirmDialog({
      title: "清除 Reranker API Key？",
      confirmLabel: "清除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete(RERANK_SECRET_ACCOUNT);
      setKeyConfigured(false);
      setKeyDraft("");
      setMsg("已清除");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip="在 RRF 融合之后再精排；支持兼容 /v1/rerank 的本地或云端服务。">
        Reranker（兼容协议）
      </CardTitle>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="启用后会在检索候选里再次精排。">
            启用 Reranker
          </LabelWithTip>
          <div className="settings-help">{enabled ? "已启用" : "未启用"}</div>
        </div>
        <Toggle
          on={enabled}
          onChange={(v) => setPreference("rerankEnabled", v)}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="填写所选 rerank 服务支持的模型 ID。">
            模型
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={model}
          onChange={(e) => setPreference("rerankModel", e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="自部署填写 http://host:port；留空使用默认服务地址。">
            服务地址
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setPreference("rerankBaseUrl", e.target.value)}
          placeholder="https://api.example.com"
          style={{ flex: 1, minWidth: 280 }}
        />
      </div>
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip="本地服务通常可留空。">
            API Key
          </LabelWithTip>
          <div className="settings-help">
            {keyConfigured ? "已存入系统钥匙串" : "未配置"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={() => {
              if (keyDraft.trim()) void saveKey();
            }}
          placeholder="rerank_xxx"
            style={inputStyle}
          />
          <button
            type="button"
            className="settings-btn primary"
            disabled={!keyDraft.trim() || savingKey}
            onClick={saveKey}
          >
            {savingKey ? "保存中…" : "保存"}
          </button>
          {keyConfigured && (
            <button type="button" className="settings-btn" onClick={clearKey}>
              清除
            </button>
          )}
        </div>
      </div>
      {msg && (
        <div
          className="settings-row"
          style={{
            color: msg.startsWith("✗") ? "var(--danger)" : "var(--text-3)",
          }}
        >
          {msg}
        </div>
      )}
    </div>
  );
}
