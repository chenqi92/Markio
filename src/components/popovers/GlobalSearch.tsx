import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { useUI } from "@/stores/ui";
import { useTabs } from "@/stores/tabs";
import { useWorkspace } from "@/stores/workspace";
import { api } from "@/lib/api";
import type { GrepHit } from "@/types";

/**
 * 真·全文搜索（⌘⇧F）：触发 Rust grep，命中文件名 + 行号 + 片段
 * 点击命中项：打开文件 + 滚到对应行。
 */
export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const openFile = useTabs((s) => s.openFile);
  const setFindQuery = useUI((s) => s.setFindQuery);
  const openFind = useUI((s) => s.openFind);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!ws || q.trim().length < 2) {
      setHits([]);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      try {
        const r = await api.grep(ws.path, q.trim(), 200);
        if (seq !== seqRef.current) return;
        setHits(r);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setErr((e as Error).message);
        setHits([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, ws?.path]);

  useEffect(() => setSel(0), [hits.length]);

  const openHit = async (h: GrepHit) => {
    if (!ws) return;
    await openFile(ws.id, h.path);
    // 同步触发文档内查找，预览面板会高亮第一处
    setFindQuery(q.trim());
    openFind(true);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(hits.length - 1, s + 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (hits[sel]) openHit(hits[sel]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hits, sel, onClose]);

  const grouped = useMemo(() => {
    const map = new Map<string, GrepHit[]>();
    for (const h of hits) {
      const arr = map.get(h.path) ?? [];
      arr.push(h);
      map.set(h.path, arr);
    }
    return Array.from(map.entries());
  }, [hits]);

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="cmdk"
        style={{ width: 720 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder={
              ws
                ? `搜索整个仓库 (${ws.name})…`
                : "请先打开一个仓库"
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="esc">⌘⇧F</span>
        </div>
        <div className="cmdk-body">
          {!ws ? (
            <div className="cmdk-empty">还没打开任何仓库</div>
          ) : q.trim().length < 2 ? (
            <div className="cmdk-empty">输入 ≥ 2 个字符开始搜索…</div>
          ) : loading ? (
            <div className="cmdk-empty">扫描中…</div>
          ) : err ? (
            <div className="cmdk-empty" style={{ color: "#ff453a" }}>
              {err}
            </div>
          ) : hits.length === 0 ? (
            <div className="cmdk-empty">没有匹配项</div>
          ) : (
            <>
              <div className="cmdk-group-h">
                {hits.length} 处命中 · {grouped.length} 个文件
              </div>
              {hits.map((h, i) => (
                <button
                  type="button"
                  key={i}
                  className={"cmdk-item" + (i === sel ? " sel" : "")}
                  onClick={() => openHit(h)}
                  onMouseEnter={() => setSel(i)}
                >
                  <div className="ico">
                    <Icon name="note" size={14} />
                  </div>
                  <div className="lbl">
                    <div className="l1">
                      {h.name}
                      {h.line > 0 && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            color: "var(--text-3)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          : {h.line}
                        </span>
                      )}
                    </div>
                    <div className="l2">{h.preview || h.path}</div>
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
