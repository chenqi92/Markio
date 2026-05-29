import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "@/stores/settings";
import { useRag } from "@/stores/rag";
import { useDialog } from "@/stores/dialog";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { api, type RagStatus } from "@/lib/api";
import { Toggle, Slider, SelectBtn } from "../../ui/controls";
import { CardTitle, LabelWithTip, SectionHeader } from "../_shared";
import { RepoGraphCard, RerankCard } from "./AI";

const EMBEDDING_PRESETS: ReadonlyArray<{
  /** 对应 AI 助手页 aiProvider 的 id；用于"复用 AI 助手 Key" */
  aiProviderId: string;
  label: string;
  baseUrl: string;
  model: string;
  dim: number;
}> = [
  {
    aiProviderId: "openai",
    label: "OpenAI · text-embedding-3-small (1536)",
    baseUrl: "https://api.openai.com",
    model: "text-embedding-3-small",
    dim: 1536,
  },
  {
    aiProviderId: "siliconflow",
    label: "SiliconFlow · BAAI/bge-m3 (1024)",
    baseUrl: "https://api.siliconflow.cn",
    model: "BAAI/bge-m3",
    dim: 1024,
  },
  {
    aiProviderId: "zhipu",
    label: "智谱 GLM · embedding-2 (1024)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "embedding-2",
    dim: 1024,
  },
  {
    aiProviderId: "dashscope",
    label: "通义千问 · text-embedding-v3 (1024)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
    dim: 1024,
  },
  {
    aiProviderId: "mistral",
    label: "Mistral · mistral-embed (1024)",
    baseUrl: "https://api.mistral.ai/v1",
    model: "mistral-embed",
    dim: 1024,
  },
  {
    aiProviderId: "together",
    label: "Together · BAAI/bge-base-en-v1.5 (768)",
    baseUrl: "https://api.together.xyz/v1",
    model: "BAAI/bge-base-en-v1.5",
    dim: 768,
  },
];

export function RagSettings() {
  const provider = useSettings((s) => s.ragProvider);
  const enabled = useSettings((s) => s.ragEnabled);
  const autoOnSave = useSettings((s) => s.ragAutoReindexOnSave);
  const topK = useSettings((s) => s.ragTopK);
  const expandLinks = useSettings((s) => s.ragExpandLinks);
  const ollamaBaseUrl = useSettings((s) => s.ragOllamaBaseUrl);
  const ollamaModel = useSettings((s) => s.ragOllamaModel);
  const ollamaDim = useSettings((s) => s.ragOllamaDim);
  const openaiBaseUrl = useSettings((s) => s.ragOpenaiBaseUrl);
  const openaiModel = useSettings((s) => s.ragOpenaiModel);
  const openaiDim = useSettings((s) => s.ragOpenaiDim);
  const aiProvider = useSettings((s) => s.aiProvider);
  const setPreference = useSettings((s) => s.setPreference);

  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [openaiKeyConfigured, setOpenaiKeyConfigured] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const confirmDialog = useDialog((s) => s.confirm);

  /** 一键把某个预设的 base_url / model / dim 应用到 OpenAI 兼容设置，并把
   *  对应 AI 助手的 keychain key (ai:{provider}) 在 Rust 端复制到 embed:openai。
   *  Key 明文不经过前端。 */
  const applyPreset = async (preset: typeof EMBEDDING_PRESETS[number]) => {
    setPreference("ragProvider", "openai");
    setPreference("ragOpenaiBaseUrl", preset.baseUrl);
    setPreference("ragOpenaiModel", preset.model);
    setPreference("ragOpenaiDim", preset.dim);
    try {
      const copied = await api.secretCopy(`ai:${preset.aiProviderId}`, "embed:openai");
      if (copied) {
        setOpenaiKeyConfigured(true);
        setMsg(`✓ 已应用 ${preset.label}（已复用 ${preset.aiProviderId} 的 Key）`);
        return;
      }
    } catch {
      /* keychain 操作失败时静默 fall through */
    }
    setMsg(`✓ 已应用 ${preset.label} · 请在下方填入 API Key`);
  };

  // 当前活动 workspace
  const wsLoaded = useWorkspaceForRag();
  const ws = wsLoaded.ws;
  const status = wsLoaded.status;
  const refresh = wsLoaded.refresh;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const has = await api.secretHas("embed:openai");
        if (!cancelled) setOpenaiKeyConfigured(has);
      } catch {
        if (!cancelled) setOpenaiKeyConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const saveOpenaiKey = async () => {
    if (!openaiKeyDraft) return;
    setSavingKey(true);
    try {
      await api.secretSet("embed:openai", openaiKeyDraft);
      setOpenaiKeyConfigured(true);
      setOpenaiKeyDraft("");
      setMsg("✓ OpenAI API Key 已存入系统钥匙串");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearOpenaiKey = async () => {
    const ok = await confirmDialog({
      title: "清除 OpenAI Embedding API Key？",
      confirmLabel: "清除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.secretDelete("embed:openai");
      setOpenaiKeyConfigured(false);
      setMsg("已清除");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const triggerReindex = async () => {
    if (!ws) {
      setMsg("请先打开一个仓库");
      return;
    }
    try {
      await useRag.getState().reindex(ws.path);
      setMsg("已触发重建，可继续使用 markio，索引在后台进行");
      refresh();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const triggerClear = async () => {
    if (!ws) return;
    const ok = await confirmDialog({
      title: "清空索引库？",
      message: "已索引的向量会全部丢失，下次需要重建。",
      confirmLabel: "清空",
      danger: true,
    });
    if (!ok) return;
    try {
      await useRag.getState().clear(ws.id, ws.path);
      setMsg("索引已清空");
      refresh();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const triggerCancel = async () => {
    if (!ws) return;
    try {
      const ok = await useRag.getState().cancel(ws.path);
      setMsg(ok ? "正在取消重建，当前文件处理完成后会停止" : "当前没有运行中的重建任务");
      refresh();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  const progress = status?.progress;
  const progressPct = progress?.total
    ? Math.round((progress.processed / Math.max(1, progress.total)) * 100)
    : 0;
  const dbSizeKb = status ? Math.max(1, Math.round(status.dbSize / 1024)) : 0;

  return (
    <>
      <SectionHeader id="rag" />

      <div className="settings-card">
        <CardTitle tip="索引存放在当前仓库的 .markio/rag.db；查询在本地完成。">
          总开关
        </CardTitle>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="关闭后 AI 检索会退回关键词 grep。">
              启用本地知识库
            </LabelWithTip>
          </div>
          <Toggle on={enabled} onChange={(v) => setPreference("ragEnabled", v)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="首次需要手动构建索引；之后保存当前笔记时只更新这个文件的 chunk。">
              索引后自动增量
            </LabelWithTip>
          </div>
          <Toggle
            on={autoOnSave}
            onChange={(v) => setPreference("ragAutoReindexOnSave", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="命中笔记后沿 [[wiki]] 和 Markdown 链接带回相关 chunk。">
              引用图谱扩展
            </LabelWithTip>
          </div>
          <Toggle
            on={expandLinks}
            onChange={(v) => setPreference("ragExpandLinks", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <div className="settings-label">检索返回条数</div>
            <div className="settings-help">{topK} 条</div>
          </div>
          <Slider
            value={topK}
            min={3}
            max={20}
            onChange={(v) => setPreference("ragTopK", v)}
          />
        </div>
      </div>

      <RerankCard />

      <RepoGraphCard />

      <div className="settings-card">
        <div className="settings-card-h">Embedding 提供方</div>
        <div className="settings-help" style={{ padding: "0 0 6px" }}>
          markio 把 embedding 接入面分成两类：本地 Ollama（离线、零成本）
          与 OpenAI 兼容协议（OpenAI / SiliconFlow / Zhipu / DashScope / Moonshot
          / xAI / Groq / DeepSeek / Together 等均走这条）。下方「快速预设」
          可一键复用 AI 助手已存的 Key 与端点。Anthropic 无 embedding API、
          Gemini 协议不同，故未列入。
        </div>
        <div className="rag-provider-tiles">
          {[
            {
              id: "ollama" as const,
              n: "本地 Ollama",
              sub: "免费、离线、推荐",
            },
            {
              id: "openai" as const,
              n: "OpenAI 兼容协议",
              sub: "OpenAI / SiliconFlow / Zhipu / DashScope …",
            },
          ].map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setPreference("ragProvider", p.id)}
              className={
                "rag-provider-tile" + (provider === p.id ? " active" : "")
              }
            >
              <div className="rag-provider-tile-name">{p.n}</div>
              <div className="rag-provider-tile-sub">{p.sub}</div>
              {provider === p.id && (
                <span className="rag-provider-tile-check">✓</span>
              )}
            </button>
          ))}
        </div>

        {provider === "ollama" ? (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="需要先运行 ollama serve。">
                  Ollama 端点
                </LabelWithTip>
              </div>
              <TextInput
                value={ollamaBaseUrl}
                placeholder="http://127.0.0.1:11434"
                onChange={(v) => setPreference("ragOllamaBaseUrl", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="推荐 nomic-embed-text（768 维），需先通过 Ollama 拉取。">
                  Embedding 模型
                </LabelWithTip>
              </div>
              <TextInput
                value={ollamaModel}
                placeholder="nomic-embed-text"
                onChange={(v) => setPreference("ragOllamaModel", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="需要与模型实际维度一致；修改后会触发整库重建。">
                  向量维度
                </LabelWithTip>
              </div>
              <NumberInput
                value={ollamaDim}
                onChange={(v) => setPreference("ragOllamaDim", v)}
              />
            </div>
          </>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="选一个已知支持 embedding 的提供方，自动填好 Base URL / 模型 / 维度，并尝试复用 AI 助手已存的 Key。Anthropic / Google Gemini / 本地 Ollama 不在这个列表（前者无 embedding API、Gemini 协议不同、Ollama 用本地选项）。">
                  快速预设
                </LabelWithTip>
                <div className="settings-help">
                  当前 AI 助手是「{aiProvider}」
                  {EMBEDDING_PRESETS.find((p) => p.aiProviderId === aiProvider)
                    ? "，可直接一键应用"
                    : "，不在预设列表（需手填）"}
                </div>
              </div>
              <SelectBtn
                value=""
                options={[
                  { value: "", label: "选一个预设…" },
                  ...EMBEDDING_PRESETS.map((p) => ({
                    value: p.aiProviderId,
                    label: p.label,
                  })),
                ]}
                onChange={(v) => {
                  const preset = EMBEDDING_PRESETS.find((p) => p.aiProviderId === v);
                  if (preset) void applyPreset(preset);
                }}
                minMenuWidth={320}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="填写兼容 OpenAI Embedding 协议的服务地址。">
                  Base URL
                </LabelWithTip>
              </div>
              <TextInput
                value={openaiBaseUrl}
                placeholder="https://api.openai.com"
                onChange={(v) => setPreference("ragOpenaiBaseUrl", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="默认 text-embedding-3-small（1536 维）。">
                  Embedding 模型
                </LabelWithTip>
              </div>
              <TextInput
                value={openaiModel}
                placeholder="text-embedding-3-small"
                onChange={(v) => setPreference("ragOpenaiModel", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="修改维度后会触发整库重建。">
                  向量维度
                </LabelWithTip>
              </div>
              <NumberInput
                value={openaiDim}
                onChange={(v) => setPreference("ragOpenaiDim", v)}
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <LabelWithTip tip="OpenAI Embedding 的 Key 存入系统钥匙串。">
                  API Key
                </LabelWithTip>
                <div className="settings-help">
                  {openaiKeyConfigured ? "已存储" : "未配置"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="password"
                  value={openaiKeyDraft}
                  placeholder="sk-..."
                  onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                  onBlur={() => {
                    if (openaiKeyDraft) void saveOpenaiKey();
                  }}
                  style={inputStyle}
                />
                <button
                  type="button"
                  className="settings-btn primary"
                  disabled={!openaiKeyDraft || savingKey}
                  onClick={saveOpenaiKey}
                >
                  {savingKey ? "保存中…" : "保存"}
                </button>
                {openaiKeyConfigured && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={clearOpenaiKey}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-h">索引状态</div>
        {!ws ? (
          <div className="settings-row" style={{ color: "var(--text-3)" }}>
            未打开任何仓库
          </div>
        ) : (
          <>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">已索引文档</div>
                <div className="settings-help">
                  {status?.totalDocs ?? 0} 份 · {status?.totalChunks ?? 0} 个 chunk
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {status?.indexedAt
                  ? new Date(status.indexedAt * 1000).toLocaleString()
                  : "未索引"}
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-l">
                <div className="settings-label">数据库大小</div>
                <div className="settings-help">
                  {status?.embeddingProvider ?? "—"} ·{" "}
                  {status?.embeddingModel ?? "—"}（{status?.embeddingDim ?? "?"}{" "}
                  维）
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                {dbSizeKb} KB
              </div>
            </div>
            {progress?.running && (
              <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {progress.cancelRequested ? "正在取消索引" : "正在索引"}{" "}
                  {progress.currentFile
                    ? progress.currentFile.split("/").slice(-1)[0]
                    : ""}{" "}
                  · {progress.processed}/{progress.total}（{progressPct}%）
                </div>
                <div
                  style={{
                    height: 4,
                    background: "var(--bg-pane-2)",
                    borderRadius: 999,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${progressPct}%`,
                      height: "100%",
                      background: "var(--accent)",
                      transition: "width .25s",
                    }}
                  />
                </div>
                {progress.lastError && (
                  <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                    {progress.lastError}
                  </div>
                )}
              </div>
            )}
            <div className="settings-row settings-row-action">
              <div className="settings-row-l">
                <div className="settings-label">索引操作</div>
                <div className="settings-help">
                  首次或更换 embedding 提供方后需要重建。
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="settings-btn primary"
                  onClick={triggerReindex}
                  disabled={progress?.running}
                >
                  {status?.totalDocs ? "重新索引整个仓库" : "首次构建索引"}
                </button>
                {progress?.running && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={triggerCancel}
                    disabled={progress.cancelRequested}
                  >
                    {progress.cancelRequested ? "取消中…" : "取消重建"}
                  </button>
                )}
                <button
                  type="button"
                  className="settings-btn"
                  onClick={triggerClear}
                >
                  清空索引
                </button>
              </div>
            </div>
          </>
        )}
        {msg && (
          <div
            style={{
              padding: "8px 16px 12px",
              fontSize: 11,
              color: msg.startsWith("✗")
                ? "var(--danger)"
                : "var(--text-3)",
            }}
          >
            {msg}
          </div>
        )}
      </div>
    </>
  );
}

function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
    />
  );
}

function NumberInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n) && n > 0) onChange(Math.round(n));
      }}
      style={{ ...inputStyle, width: 100 }}
    />
  );
}

const inputStyle: CSSProperties = {
  background: "var(--bg-pane-2)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  color: "var(--text)",
  outline: "none",
  minWidth: 180,
};

function sameWorkspacePath(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/\\/g, "/").replace(/\/+$/, "");
  const aa = norm(a);
  const bb = norm(b);
  return /^[a-zA-Z]:\//.test(aa) ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

function useWorkspaceForRag() {
  const activeId = useWorkspaceStore((s) => s.activeId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const ws = useMemo(() => {
    const active = workspaces.find((w) => w.id === activeId);
    return active ? { id: active.id, path: active.path } : null;
  }, [activeId, workspaces]);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!ws) {
      setStatus(null);
      return;
    }
    try {
      const r = await api.ragStatus(ws.path);
      setStatus(r);
    } catch (e) {
      console.warn("[rag.status] failed", e);
    }
  }, [ws]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    if (!ws) {
      setStatus(null);
      return;
    }
    void refresh();
    void (async () => {
      try {
        unlisten = await listen<RagStatus>("rag-status", (e) => {
          if (cancelled || !sameWorkspacePath(e.payload.workspace, ws.path)) return;
          setStatus(e.payload);
        });
      } catch (e) {
        console.warn("[rag.status.listen] failed", e);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh, ws]);

  return { ws, status, refresh };
}
