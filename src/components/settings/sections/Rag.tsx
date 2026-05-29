import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "@/stores/settings";
import { useRag } from "@/stores/rag";
import { useDialog } from "@/stores/dialog";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { api, type RagStatus } from "@/lib/api";
import { Toggle, Slider, SelectBtn } from "../../ui/controls";
import { CardTitle, LabelWithTip } from "../_shared";
import { RepoGraphCard, RerankCard } from "./AI";

/** OpenAI 兼容协议的 embedding 源预设：选中后自动填 baseUrl/model/dim；
 *  Key 复用「AI 源池」里 ai:{aiProviderId} 的 Key，无需在这里重复填。 */
const EMBEDDING_PRESETS: ReadonlyArray<{
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
  const embedSource = useSettings((s) => s.ragEmbedSource);
  const embedModel = useSettings((s) => s.ragEmbedModel);
  const embedBaseUrl = useSettings((s) => s.ragEmbedBaseUrl);
  const embedDim = useSettings((s) => s.ragEmbedDim);
  const enabled = useSettings((s) => s.ragEnabled);
  const autoOnSave = useSettings((s) => s.ragAutoReindexOnSave);
  const topK = useSettings((s) => s.ragTopK);
  const expandLinks = useSettings((s) => s.ragExpandLinks);
  const setPreference = useSettings((s) => s.setPreference);

  const [msg, setMsg] = useState<string | null>(null);
  const [keyReady, setKeyReady] = useState<boolean | null>(null);
  const confirmDialog = useDialog((s) => s.confirm);

  const isOllama = embedSource === "ollama";

  // 云端源的 Key 复用 AI 源池 ai:{source}；这里只读状态做提示，不再单独存 Key。
  useEffect(() => {
    if (isOllama) {
      setKeyReady(null);
      return;
    }
    let cancelled = false;
    api
      .secretHas(`ai:${embedSource}`)
      .then((h) => {
        if (!cancelled) setKeyReady(h);
      })
      .catch(() => {
        if (!cancelled) setKeyReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [embedSource, isOllama]);

  const pickSource = (id: string) => {
    if (id === "ollama") {
      setPreference("ragEmbedSource", "ollama");
      setPreference("ragEmbedBaseUrl", "http://127.0.0.1:11434");
      setPreference("ragEmbedModel", "nomic-embed-text");
      setPreference("ragEmbedDim", 768);
      return;
    }
    setPreference("ragEmbedSource", id as never);
    const preset = EMBEDDING_PRESETS.find((p) => p.aiProviderId === id);
    if (preset) {
      setPreference("ragEmbedBaseUrl", preset.baseUrl);
      setPreference("ragEmbedModel", preset.model);
      setPreference("ragEmbedDim", preset.dim);
    }
  };

  const wsLoaded = useWorkspaceForRag();
  const ws = wsLoaded.ws;
  const status = wsLoaded.status;
  const refresh = wsLoaded.refresh;

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

  const sourceOptions = [
    { value: "ollama", label: "本地 Ollama（离线 · 免费）" },
    ...EMBEDDING_PRESETS.map((p) => ({ value: p.aiProviderId, label: p.label })),
  ];

  return (
    <>
      <div className="settings-subhead">知识库 / 检索（RAG）</div>

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
        <div className="settings-card-h">Embedding 源</div>
        <div className="settings-help" style={{ padding: "0 0 6px" }}>
          向量化用哪个源。本地 Ollama 离线免费；云端源走 OpenAI 兼容协议，
          <b>Key 复用上方「AI 源」池</b>（ai:{"{"}源{"}"}），不用在这里重复填。
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="选中云端源会自动填好 Base URL / 模型 / 维度，并复用该源在 AI 源池里的 Key。">
              Embedding 源
            </LabelWithTip>
          </div>
          <SelectBtn
            value={embedSource}
            options={sourceOptions}
            onChange={pickSource}
            minMenuWidth={320}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip={isOllama ? "需要先运行 ollama serve。" : "兼容 OpenAI Embedding 协议的服务地址。"}>
              {isOllama ? "Ollama 端点" : "Base URL"}
            </LabelWithTip>
          </div>
          <TextInput
            value={embedBaseUrl}
            placeholder={isOllama ? "http://127.0.0.1:11434" : "https://api.openai.com"}
            onChange={(v) => setPreference("ragEmbedBaseUrl", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip={isOllama ? "推荐 nomic-embed-text（768 维），需先通过 Ollama 拉取。" : "如 text-embedding-3-small。"}>
              Embedding 模型
            </LabelWithTip>
          </div>
          <TextInput
            value={embedModel}
            placeholder={isOllama ? "nomic-embed-text" : "text-embedding-3-small"}
            onChange={(v) => setPreference("ragEmbedModel", v)}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-l">
            <LabelWithTip tip="需要与模型实际维度一致；修改后会触发整库重建。">
              向量维度
            </LabelWithTip>
          </div>
          <NumberInput
            value={embedDim}
            onChange={(v) => setPreference("ragEmbedDim", v)}
          />
        </div>
        {!isOllama && (
          <div className="settings-row">
            <div className="settings-row-l">
              <div className="settings-label">API Key</div>
              <div className="settings-help">
                {keyReady === null
                  ? "检查中…"
                  : keyReady
                    ? `已就绪 · 复用「${embedSource}」在 AI 源池里的 Key`
                    : `「${embedSource}」还没配置 Key —— 请到上方「AI 源」里添加该源的 Key`}
              </div>
            </div>
          </div>
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
                  {status?.embeddingModel ?? "—"}（{status?.embeddingDim ?? "?"} 维）
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
                  首次或更换 embedding 源后需要重建。
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
                <button type="button" className="settings-btn" onClick={triggerClear}>
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
              color: msg.startsWith("✗") ? "var(--danger)" : "var(--text-3)",
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
