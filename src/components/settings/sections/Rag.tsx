import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Toggle, Slider, SelectBtn } from "../../ui/controls";
import { useSettings } from "@/stores/settings";
import { useRag } from "@/stores/rag";
import { useWorkspace as useWorkspaceStore } from "@/stores/workspace";
import { useDialog } from "@/stores/dialog";
import { api, type RagStatus } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { RagGraphMini } from "../RagGraphMini";
import {
  SectionHeader,
  CardTitle,
  LabelWithTip,
  TextInput,
  NumberInput,
  inputStyle,
} from "./_shared";

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
          style={{ flex: 1, minWidth: 220 }}
        />
        <button className="settings-btn" onClick={save} disabled={!endpoint}>
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
      <div className="settings-row">
        <div className="settings-row-l">
          <LabelWithTip tip={t("settings.picgo.s3ProbeTip")}>
            {t("settings.picgo.s3Probe")}
          </LabelWithTip>
        </div>
        <button
          className="settings-btn"
          onClick={testConnection}
          disabled={testing || !endpoint || !bucket || !accessKeyId}
        >
          {testing ? t("settings.picgo.s3Testing") : t("settings.picgo.s3TestBtn")}
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

export function WebDavCard() {
  const baseUrl = useSettings((s) => s.webdavBaseUrl);
  const username = useSettings((s) => s.webdavUsername);
  const remoteDir = useSettings((s) => s.webdavRemoteDir);
  const setPreference = useSettings((s) => s.setPreference);
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
          onChange={(e) => setPreference("webdavRemoteDir", e.target.value)}
          placeholder="markio"
          style={{ flex: 1, minWidth: 220 }}
        />
      </div>
      {/* 测试连接已经移到上方 .sync-card-status，这里只留初始化 / 列出 */}
      <div className="settings-action-row">
        <button
          className="settings-btn"
          disabled={!baseUrl || busy !== null}
          onClick={() =>
            wrap("远端目录初始化", () =>
              api.webdavMkcol(baseUrl, auth(), remoteDir || "/"),
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

function RepoGraphCard() {
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

function RerankCard() {
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
        const has = await api.secretHas("rerank:cohere");
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
      await api.secretSet("rerank:cohere", value);
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
      await api.secretDelete("rerank:cohere");
      setKeyConfigured(false);
      setKeyDraft("");
      setMsg("已清除");
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    }
  };

  return (
    <div className="settings-card">
      <CardTitle tip="在 RRF 融合之后再精排；支持 Cohere API 和兼容 /v1/rerank 的本地服务。">
        Reranker（cohere 兼容协议）
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
          <LabelWithTip tip="Cohere 默认 rerank-multilingual-v3.0。">
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
          <LabelWithTip tip="留空使用 https://api.cohere.com；自部署填写 http://host:port。">
            服务地址
          </LabelWithTip>
        </div>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setPreference("rerankBaseUrl", e.target.value)}
          placeholder="https://api.cohere.com"
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
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="cohere_xxx"
            style={inputStyle}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!keyDraft.trim() || savingKey}
            onClick={saveKey}
          >
            保存
          </button>
          {keyConfigured && (
            <button type="button" className="btn-ghost" onClick={clearKey}>
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

/** 已知支持 OpenAI 兼容 /v1/embeddings 协议的提供方预设：选一个就自动填好
 *  base_url + 推荐模型 + 维度 + 应该到哪个 keychain 账户去取 key。 */
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            padding: "10px 16px",
          }}
        >
          {[
            {
              id: "ollama" as const,
              n: "本地 Ollama",
              sub: "免费、离线、推荐",
            },
            {
              id: "openai" as const,
              n: "OpenAI 兼容",
              sub: "需 API Key，联网调用",
            },
          ].map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setPreference("ragProvider", p.id)}
              style={{
                position: "relative",
                padding: "9px 12px",
                background:
                  provider === p.id ? "var(--accent-glow)" : "var(--bg-pane-2)",
                border:
                  "1px solid " +
                  (provider === p.id ? "var(--accent)" : "var(--border)"),
                borderRadius: 9,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div
                style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}
              >
                {p.n}
              </div>
              <div
                style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}
              >
                {p.sub}
              </div>
              {provider === p.id && (
                <span
                  style={{
                    position: "absolute",
                    top: 6,
                    right: 8,
                    color: "var(--accent)",
                    fontWeight: 700,
                  }}
                >
                  ✓
                </span>
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
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={openaiKeyDraft}
                  placeholder="sk-..."
                  onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                  style={inputStyle}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!openaiKeyDraft || savingKey}
                  onClick={saveOpenaiKey}
                >
                  保存
                </button>
                {openaiKeyConfigured && (
                  <button
                    type="button"
                    className="btn-ghost"
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
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: "10px 16px",
              }}
            >
              <button
                type="button"
                className="btn-primary"
                onClick={triggerReindex}
                disabled={progress?.running}
              >
                {status?.totalDocs ? "重新索引整个仓库" : "首次构建索引"}
              </button>
              {progress?.running && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={triggerCancel}
                  disabled={progress.cancelRequested}
                >
                  {progress.cancelRequested ? "取消中…" : "取消重建"}
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={triggerClear}>
                清空索引
              </button>
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
