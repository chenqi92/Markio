import { useEffect, useMemo, useState } from "react";
import { Icon } from "../ui/Icon";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { api } from "@/lib/api";
import type { NoteFrontmatter } from "@/types";

interface KeyEntry {
  key: string;
  count: number;
  values: Map<string, number>;
}

/** Frontmatter 浏览：扫描当前仓库全部 md 的 frontmatter，
 *  上方按 key 展示 chip（含计数），点击展开值。
 *  选中 key=value 后下方列出匹配笔记，点击打开。 */
export function PropertyExplorer() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const openPath = useTabs((s) => s.openPath);
  const setToast = useUI((s) => s.setToast);

  const [data, setData] = useState<NoteFrontmatter[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeVal, setActiveVal] = useState<string | null>(null);

  const reload = async () => {
    if (!ws) return;
    setLoading(true);
    try {
      const list = await api.scanFrontmatter(ws.path);
      setData(list);
    } catch (e) {
      setToast({ stage: "error", message: `扫描失败：${(e as Error).message}` });
      setTimeout(() => setToast(null), 2500);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.id]);

  const keys = useMemo<KeyEntry[]>(() => {
    const map = new Map<string, KeyEntry>();
    for (const note of data) {
      for (const [k, vals] of Object.entries(note.fields)) {
        let entry = map.get(k);
        if (!entry) {
          entry = { key: k, count: 0, values: new Map() };
          map.set(k, entry);
        }
        entry.count += 1;
        for (const v of vals) {
          entry.values.set(v, (entry.values.get(v) ?? 0) + 1);
        }
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    if (filter.trim()) {
      const q = filter.toLowerCase();
      return arr.filter((e) => e.key.toLowerCase().includes(q));
    }
    return arr;
  }, [data, filter]);

  const activeEntry = useMemo(
    () => keys.find((k) => k.key === activeKey) ?? null,
    [keys, activeKey],
  );

  const matchedNotes = useMemo(() => {
    if (!activeKey) return [];
    return data.filter((n) => {
      const vals = n.fields[activeKey];
      if (!vals) return false;
      return activeVal == null ? true : vals.includes(activeVal);
    });
  }, [data, activeKey, activeVal]);

  if (!ws) {
    return <div className="ti-empty">没有打开的仓库</div>;
  }

  return (
    <div className="tag-cloud-pane">
      <div className="ti-h">
        <div className="ti-title">
          <Icon name="hash" size={12} />
          <span>frontmatter</span>
          <span className="ti-count">{keys.length}</span>
        </div>
      </div>

      <div className="ti-toolbar">
        <input
          className="ti-search"
          placeholder="过滤字段…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="ti-refresh"
          onClick={() => void reload()}
          title="重新扫描"
          disabled={loading}
        >
          <Icon name="sync" size={12} />
        </button>
      </div>

      <div className="tag-cloud-list">
        {loading ? (
          <div className="ti-empty">扫描中…</div>
        ) : keys.length === 0 ? (
          <div className="ti-empty">
            还没有任何 frontmatter。
            <br />
            在 md 顶部加 `---` 块即可。
          </div>
        ) : (
          <div className="tag-cloud">
            {keys.map((e) => (
              <button
                type="button"
                key={e.key}
                className={
                  "tag-chip" + (activeKey === e.key ? " active" : "")
                }
                onClick={() => {
                  setActiveKey((cur) => (cur === e.key ? null : e.key));
                  setActiveVal(null);
                }}
                title={`${e.values.size} 个不同值`}
              >
                <span>{e.key}</span>
                <span className="tag-chip-cnt">{e.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {activeEntry && (
        <div className="tag-detail">
          <div className="tag-detail-h">
            <span className="tag-detail-name">{activeEntry.key}</span>
            <span className="tag-detail-cnt">{activeEntry.values.size} 值</span>
          </div>

          <div className="tag-detail-actions" style={{ flexWrap: "wrap", gap: 4 }}>
            <button
              type="button"
              className={"tag-chip" + (activeVal == null ? " active" : "")}
              onClick={() => setActiveVal(null)}
            >
              全部
              <span className="tag-chip-cnt">{activeEntry.count}</span>
            </button>
            {Array.from(activeEntry.values.entries())
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([v, c]) => (
                <button
                  type="button"
                  key={v}
                  className={"tag-chip" + (activeVal === v ? " active" : "")}
                  onClick={() => setActiveVal((cur) => (cur === v ? null : v))}
                  title={v}
                >
                  <span
                    style={{
                      maxWidth: 160,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {v || "(空)"}
                  </span>
                  <span className="tag-chip-cnt">{c}</span>
                </button>
              ))}
          </div>

          <div className="tag-detail-list">
            {matchedNotes.length === 0 ? (
              <div className="ti-empty" style={{ padding: 12 }}>
                没有匹配的笔记
              </div>
            ) : (
              matchedNotes.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  className="tag-ref-row"
                  onClick={() => void openPath(n.path)}
                  title={n.path}
                >
                  <Icon name="note" size={12} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {n.name}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
