import { useEffect, useMemo, useState } from "react";
import { api, isDesktop } from "@/lib/api";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";

interface Node {
  id: number;
  path: string;
  inDegree: number;
  outDegree: number;
}
interface Edge {
  from: number;
  to: number;
}
interface Graph {
  nodes: Node[];
  edges: Edge[];
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? p;
}

/** 简单的环形布局：节点按入度降序均匀分布在一个圆上。 */
function layout(nodes: Node[], radius: number) {
  const cx = 0;
  const cy = 0;
  const sorted = [...nodes].sort((a, b) => b.inDegree - a.inDegree);
  const n = sorted.length;
  const positions = new Map<number, { x: number; y: number; r: number }>();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = cx + radius * Math.cos(ang);
    const y = cy + radius * Math.sin(ang);
    // 圆圈半径放大：基线 10、随入度对数增长，封顶 38
    const r = Math.max(10, Math.min(38, 10 + Math.sqrt(sorted[i].inDegree) * 6));
    positions.set(sorted[i].id, { x, y, r });
  }
  return { positions, ordered: sorted };
}

export function GraphView({ title }: { title?: string }) {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const openPath = useTabs((s) => s.openPath);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const fetch = async () => {
    if (!ws || !isDesktop()) return;
    setBusy(true);
    setErr(null);
    try {
      const g = await api.ragRepoGraph(ws.path);
      setGraph(g);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws?.path]);

  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  // viewBox 尺寸固定，节点按容器自适应——少节点不会缩成一团，多节点也撑得开
  const view = 1000;
  const radius = Math.min(view * 0.42, Math.max(280, 80 + nodes.length * 5));

  const positions = useMemo(() => layout(nodes, radius).positions, [nodes, radius]);

  const hoveredNeighbors = useMemo(() => {
    if (hover === null) return new Set<number>();
    const s = new Set<number>([hover]);
    for (const e of edges) {
      if (e.from === hover) s.add(e.to);
      if (e.to === hover) s.add(e.from);
    }
    return s;
  }, [hover, edges]);

  if (!ws) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <p style={{ color: "var(--text-3)" }}>请先选择一个工作仓库</p>
      </div>
    );
  }
  if (err) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{title ?? "知识地图"}</h2>
        <p style={{ color: "#ff453a" }}>加载失败：{err}</p>
        <button className="settings-btn" onClick={() => void fetch()}>重试</button>
      </div>
    );
  }
  if (busy || !graph) {
    return (
      <div className="preview" style={{ padding: 24, color: "var(--text-3)" }}>
        正在计算笔记之间的链接…
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{title ?? "知识地图"}</h2>
        <p style={{ color: "var(--text-3)" }}>
          仓库里还没有 <code>[[wiki]]</code> 链接。建链接后回来这里看图。
        </p>
        <button className="settings-btn" onClick={() => void fetch()}>
          刷新
        </button>
      </div>
    );
  }

  const hubs = [...nodes].sort((a, b) => b.inDegree - a.inDegree).slice(0, 5);
  const orphans = nodes.filter((n) => n.inDegree === 0 && n.outDegree === 0);

  return (
    <div className="preview gv-view">
      <div className="gv-header">
        <div>
          <h1 className="gv-title">{title ?? "知识地图"}</h1>
          <div className="gv-meta">
            <span>{nodes.length} 笔记</span>
            <span className="dot">·</span>
            <span>{edges.length} 条 [[ 链接</span>
            {orphans.length > 0 && (
              <>
                <span className="dot">·</span>
                <span style={{ color: "var(--text-3)" }}>
                  {orphans.length} 孤立
                </span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          className="settings-btn"
          onClick={() => void fetch()}
        >
          重新计算
        </button>
      </div>

      <div className="gv-board">
        <svg
          viewBox={`${-view / 2} ${-view / 2} ${view} ${view}`}
          preserveAspectRatio="xMidYMid meet"
          width="100%"
          height="100%"
        >
          <defs>
            {/* 地图风格的细网格 + 等距同心圆，让"知识地图"真的有 map 感 */}
            <pattern
              id="gv-grid"
              x="0"
              y="0"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke="var(--border)"
                strokeOpacity="0.35"
                strokeWidth="0.6"
              />
            </pattern>
            <radialGradient id="gv-vignette" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.04" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect
            x={-view / 2}
            y={-view / 2}
            width={view}
            height={view}
            fill="url(#gv-grid)"
          />
          <rect
            x={-view / 2}
            y={-view / 2}
            width={view}
            height={view}
            fill="url(#gv-vignette)"
          />
          {/* 同心环作为"等高线"暗示 */}
          {[radius * 0.4, radius * 0.7, radius].map((r, i) => (
            <circle
              key={i}
              cx={0}
              cy={0}
              r={r}
              fill="none"
              stroke="var(--border)"
              strokeOpacity="0.35"
              strokeWidth="0.6"
              strokeDasharray="3 6"
            />
          ))}
          {edges.map((e, i) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            const dim =
              hover !== null && !(hoveredNeighbors.has(e.from) && hoveredNeighbors.has(e.to));
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={dim ? "var(--border)" : "var(--accent)"}
                strokeOpacity={dim ? 0.25 : 0.55}
                strokeWidth={dim ? 1 : 1.6}
              />
            );
          })}
          {nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const dim = hover !== null && !hoveredNeighbors.has(n.id);
            return (
              <g
                key={n.id}
                className="gv-node"
                transform={`translate(${p.x}, ${p.y})`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => void openPath(n.path)}
                style={{ cursor: "pointer" }}
              >
                <circle
                  r={p.r}
                  fill={dim ? "var(--bg-pane-2)" : "var(--accent)"}
                  fillOpacity={dim ? 0.4 : 0.9}
                  stroke="var(--bg)"
                  strokeWidth="2.5"
                />
                <text
                  x="0"
                  y={p.r + 18}
                  textAnchor="middle"
                  fontSize="14"
                  fontWeight="500"
                  fill={dim ? "var(--text-3)" : "var(--text)"}
                  opacity={dim ? 0.5 : 1}
                  style={{ pointerEvents: "none" }}
                >
                  {basename(n.path)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {hubs.length > 0 && (
        <div className="gv-aside">
          <div className="gv-aside-h">高被引（top {hubs.length}）</div>
          <ul className="gv-aside-list">
            {hubs.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => void openPath(h.path)}
                  className="gv-hub-btn"
                >
                  <span className="gv-hub-deg">{h.inDegree}↓</span>
                  <span>{basename(h.path)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
