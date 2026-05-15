import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface Point {
  lat: number;
  lon: number;
  /** 水深 m，正值；缺省时按"标记点"渲染 */
  depth?: number;
  /** 选填：弹窗标题 */
  label?: string;
  /** 选填：弹窗附加描述 */
  desc?: string;
}

interface MapData {
  /** 中心 [lon, lat]；缺省时按所有 points bounds 自适应 */
  center?: [number, number];
  zoom?: number;
  /** 倾斜角 0-85；>0 时呈"伪 3D"视角 */
  pitch?: number;
  /** 旋转角 */
  bearing?: number;
  points?: Point[];
  /** 色阶端点（米）。缺省 [0, 50] */
  depthRange?: [number, number];
}

interface Props {
  body: string;
  title?: string;
}

/** 解析 body 中第一个 ```json 块；找不到 / 解析失败返回 null */
function parseMapData(body: string): MapData | null {
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    if (v && typeof v === "object") return v as MapData;
  } catch {
    /* fall through */
  }
  return null;
}

/** 蓝紫渐变：浅 (0m) → 深 (max) */
function depthColor(depth: number, range: [number, number]): string {
  const [lo, hi] = range;
  const t = Math.max(0, Math.min(1, (depth - lo) / Math.max(1e-3, hi - lo)));
  // 0 → #7dd3fc (sky-300) → #3b82f6 (blue-500) → #1e3a8a (blue-900) → #1e1b4b (indigo-950)
  const stops = [
    [125, 211, 252],
    [59, 130, 246],
    [30, 58, 138],
    [30, 27, 75],
  ];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

/** 不需要 API key 的免费栅格底图（Carto positron） */
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export function GeoMapView({ body, title }: Props) {
  const data = useMemo(() => parseMapData(body), [body]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const points = data?.points ?? [];
  const depthRange: [number, number] = data?.depthRange ?? [0, 50];
  const hasDepth = points.some((p) => typeof p.depth === "number");

  useEffect(() => {
    if (!containerRef.current || !data) return;
    let center: [number, number];
    if (data.center) {
      center = data.center;
    } else if (points.length > 0) {
      const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
      const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
      center = [lon, lat];
    } else {
      center = [114.305, 30.59]; // 武汉作为占位
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: FALLBACK_STYLE,
      center,
      zoom: data.zoom ?? 11,
      pitch: data.pitch ?? 0,
      bearing: data.bearing ?? 0,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }),
      "bottom-left",
    );

    // 自动 fit 到 points 包围盒
    if (!data.center && points.length > 1) {
      const bounds = new maplibregl.LngLatBounds();
      for (const p of points) bounds.extend([p.lon, p.lat]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 0 });
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // 点位用 DOM marker 渲染（colored circle + tooltip 钩子）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;
    const markers: maplibregl.Marker[] = [];
    for (const p of points) {
      const el = document.createElement("div");
      el.className = "geo-marker";
      const color = typeof p.depth === "number"
        ? depthColor(p.depth, depthRange)
        : "var(--accent)";
      const size = typeof p.depth === "number" ? Math.max(10, Math.min(28, 8 + p.depth / 4)) : 14;
      el.style.cssText = `
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: ${color};
        border: 2px solid #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25);
        cursor: pointer;
      `;
      el.addEventListener("mouseenter", (e) => {
        setHover(p);
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const c = containerRef.current?.getBoundingClientRect();
        if (c) setHoverPos({ x: r.left - c.left + r.width / 2, y: r.top - c.top });
      });
      el.addEventListener("mouseleave", () => {
        setHover(null);
        setHoverPos(null);
      });
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([p.lon, p.lat])
        .addTo(map);
      markers.push(marker);
    }
    return () => markers.forEach((m) => m.remove());
  }, [points, depthRange]);

  if (!data) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{title ?? "地图"}</h2>
        <p style={{ color: "var(--text-3)" }}>
          在 frontmatter 设 <code>view: geomap</code>，正文里放一段 fenced JSON：
        </p>
        <pre>
          <code>{`\`\`\`json
{
  "center": [114.305, 30.59],
  "zoom": 12,
  "pitch": 45,
  "depthRange": [0, 30],
  "points": [
    { "lat": 30.59, "lon": 114.30, "depth": 5,  "label": "码头 A" },
    { "lat": 30.60, "lon": 114.31, "depth": 18, "label": "排体 1" },
    { "lat": 30.61, "lon": 114.32, "depth": 27, "label": "深槽" }
  ]
}
\`\`\``}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="preview gm-view">
      <div className="gm-header">
        <div>
          <h1 className="gm-title">{title ?? "地图"}</h1>
          <div className="gm-meta">
            <span>{points.length} 个观测点</span>
            {hasDepth && (
              <>
                <span className="dot">·</span>
                <span>水深 {depthRange[0]}–{depthRange[1]} m</span>
              </>
            )}
            {data.pitch && data.pitch > 0 && (
              <>
                <span className="dot">·</span>
                <span>倾斜 {data.pitch}°</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="gm-board">
        <div ref={containerRef} className="gm-canvas" />
        {hasDepth && (
          <div className="gm-legend">
            <div className="gm-legend-h">水深 (m)</div>
            <div
              className="gm-legend-bar"
              style={{
                background: `linear-gradient(to right, ${depthColor(depthRange[0], depthRange)} 0%, ${depthColor((depthRange[0] + depthRange[1]) / 2, depthRange)} 50%, ${depthColor(depthRange[1], depthRange)} 100%)`,
              }}
            />
            <div className="gm-legend-labels">
              <span>{depthRange[0]}</span>
              <span>{Math.round((depthRange[0] + depthRange[1]) / 2)}</span>
              <span>{depthRange[1]}</span>
            </div>
          </div>
        )}
        {hover && hoverPos && (
          <div
            className="gm-tooltip"
            style={{ left: hoverPos.x, top: hoverPos.y - 8 }}
          >
            <div className="gm-tip-h">{hover.label ?? `${hover.lat.toFixed(4)}, ${hover.lon.toFixed(4)}`}</div>
            {typeof hover.depth === "number" && (
              <div className="gm-tip-row">
                <span>水深</span>
                <b>{hover.depth.toFixed(2)} m</b>
              </div>
            )}
            <div className="gm-tip-row">
              <span>经纬</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {hover.lon.toFixed(4)}, {hover.lat.toFixed(4)}
              </span>
            </div>
            {hover.desc && <div className="gm-tip-desc">{hover.desc}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
