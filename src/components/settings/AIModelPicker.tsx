import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { api } from "@/lib/api";
import {
  clearCached,
  getCached,
  getCachedAt,
  setCached,
  type CachedModel,
} from "@/lib/aiModelsCache";
import type { AIProviderDef } from "@/lib/ai-providers";

interface Props {
  provider: AIProviderDef;
  endpoint: string;
  value: string;
  onChange: (id: string) => void;
}

/**
 * AI 模型选择器：输入框永远是真值（手填模型 id 也算数），右边一个"拉取"
 * 按钮 + 一个 v 下拉按钮。下拉里是搜索框 + 分组（聚合站走 vendor/ 前缀分组）
 * + 内置预设兜底（拉不到时也能选）。结果按 provider 缓存 24h 到 localStorage。
 */
export function AIModelPicker({ provider, endpoint, value, onChange }: Props) {
  const [remote, setRemote] = useState<CachedModel[] | null>(() =>
    getCached(provider.id),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(() =>
    getCachedAt(provider.id),
  );
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 切 provider 时重读缓存、收起下拉
  useEffect(() => {
    setRemote(getCached(provider.id));
    setFetchedAt(getCachedAt(provider.id));
    setOpen(false);
    setQuery("");
    setErr(null);
  }, [provider.id]);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const refresh = async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await api.aiListModels(
        provider.id,
        endpoint || undefined,
        undefined,
      );
      setCached(provider.id, list);
      setRemote(list);
      setFetchedAt(Date.now());
      if (list.length === 0) {
        setErr("接口返回 0 个模型");
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 合并：远程（如有） + 兜底预设（去重）
  const all: CachedModel[] = useMemo(() => {
    const seen = new Set<string>();
    const out: CachedModel[] = [];
    if (remote && remote.length > 0) {
      for (const m of remote) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
    }
    for (const m of provider.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ id: m.id, label: m.name });
    }
    return out;
  }, [remote, provider]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.label?.toLowerCase().includes(q) ?? false) ||
        (m.group?.toLowerCase().includes(q) ?? false),
    );
  }, [all, query]);

  // 分组：有 group 的按 group 分组，其余归到 "其他"
  const groups = useMemo(() => {
    const map = new Map<string, CachedModel[]>();
    for (const m of filtered) {
      const g = m.group ?? "";
      const arr = map.get(g) ?? [];
      arr.push(m);
      map.set(g, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "" && b !== "") return 1; // "其他" 放最后
      if (b === "" && a !== "") return -1;
      return a.localeCompare(b);
    });
  }, [filtered]);

  const sinceText = useMemo(() => {
    if (!fetchedAt) return "未拉取";
    const mins = Math.round((Date.now() - fetchedAt) / 60_000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} 小时前`;
    return `${Math.round(hrs / 24)} 天前`;
  }, [fetchedAt]);

  return (
    <div ref={popRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={provider.defaultModel || "model id"}
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
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
          title={`联网拉取 ${provider.name} 的最新模型列表（24h 缓存）`}
          className="settings-btn"
          style={{ padding: "5px 8px", fontSize: 11 }}
        >
          {loading ? "拉取中…" : <><Icon name="sync" size={11} /> 拉取</>}
        </button>
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          className="settings-btn"
          style={{ padding: "5px 8px", fontSize: 11 }}
          title="从列表中选"
        >
          {open ? "▲" : "▼"} ({all.length})
        </button>
      </div>
      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 200,
            width: 360,
            maxHeight: 380,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-pane)",
            border: "1px solid var(--border-strong)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 10px",
              borderBottom: "0.5px solid var(--border)",
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索：模型 id / 厂商 / 标签"
              style={{
                flex: 1,
                padding: "4px 8px",
                background: "var(--bg-input)",
                border: "0.5px solid var(--border-strong)",
                borderRadius: 5,
                fontSize: 12,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
              }}
            />
            <span style={{ fontSize: 10, color: "var(--text-3)" }}>
              {sinceText}
            </span>
            {fetchedAt && (
              <button
                type="button"
                className="settings-btn"
                style={{ padding: "2px 6px", fontSize: 10 }}
                onClick={() => {
                  clearCached(provider.id);
                  setRemote(null);
                  setFetchedAt(null);
                }}
                title="清掉本地缓存（不影响已选模型）"
              >
                清缓存
              </button>
            )}
          </div>
          {err && (
            <div
              style={{
                padding: "6px 10px",
                fontSize: 11,
                background: "var(--bg-pane-2)",
                color: "var(--danger, #c33)",
                borderBottom: "0.5px solid var(--border)",
              }}
            >
              ✗ {err}
            </div>
          )}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {groups.length === 0 ? (
              <div
                style={{
                  padding: "16px 10px",
                  textAlign: "center",
                  fontSize: 12,
                  color: "var(--text-3)",
                }}
              >
                {remote ? "没有匹配项" : "尚未拉取 · 点上方拉取按钮联网获取"}
              </div>
            ) : (
              groups.map(([g, items]) => (
                <div key={g || "_other"}>
                  {g && (
                    <div
                      style={{
                        padding: "6px 10px 2px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-3)",
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        background: "var(--bg-pane-2)",
                        position: "sticky",
                        top: 0,
                      }}
                    >
                      {g}
                    </div>
                  )}
                  {items.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onChange(m.id);
                        setOpen(false);
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 10px",
                        background:
                          value === m.id
                            ? "var(--accent-glow)"
                            : "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                        color: "var(--text)",
                        borderBottom: "0.5px solid var(--border)",
                      }}
                      onMouseEnter={(e) => {
                        if (value !== m.id) {
                          (e.currentTarget as HTMLButtonElement).style.background =
                            "var(--bg-pane-2)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (value !== m.id) {
                          (e.currentTarget as HTMLButtonElement).style.background =
                            "transparent";
                        }
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11.5,
                        }}
                      >
                        {g ? m.label ?? m.id : m.id}
                      </div>
                      {(m.label && !g) || m.contextLength ? (
                        <div
                          style={{
                            fontSize: 10,
                            color: "var(--text-3)",
                            marginTop: 1,
                          }}
                        >
                          {m.label && !g ? m.label : ""}
                          {m.label && !g && m.contextLength ? " · " : ""}
                          {m.contextLength
                            ? `${Math.round(m.contextLength / 1024)}K ctx`
                            : ""}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
