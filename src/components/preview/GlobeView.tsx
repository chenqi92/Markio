import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface Point {
  lat: number;
  lon: number;
  /** 水深 / 高度 (m)，决定柱体高度和颜色 */
  depth?: number;
  label?: string;
  desc?: string;
}

interface GlobeData {
  center?: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  points?: Point[];
  depthRange?: [number, number];
  /** 柱体高度的视觉放大系数（默认 1500） */
  extrudeScale?: number;
}

interface Props {
  body: string;
  title?: string;
}

function parseGlobeData(body: string): GlobeData | null {
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    if (v && typeof v === "object") return v as GlobeData;
  } catch {
    /* ignore */
  }
  return null;
}

function depthColor(depth: number, range: [number, number]): string {
  const [lo, hi] = range;
  const t = Math.max(0, Math.min(1, (depth - lo) / Math.max(1e-3, hi - lo)));
  // 浅 → 深: 黄 → 橙 → 红 → 紫
  const stops = [
    [253, 224, 71], // amber-300
    [251, 146, 60], // orange-400
    [220, 38, 38], // red-600
    [88, 28, 135], // purple-900
  ];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

const SAT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Imagery © Esri",
    },
  },
  layers: [{ id: "sat", type: "raster", source: "sat" }],
};

export function GlobeView({ body, title }: Props) {
  const data = useMemo(() => parseGlobeData(body), [body]);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);

  const points = data?.points ?? [];
  const depthRange: [number, number] = data?.depthRange ?? [0, 50];
  const extrudeScale = data?.extrudeScale ?? 1500;
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
      center = [114.305, 30.59];
    }
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SAT_STYLE,
      center,
      zoom: data.zoom ?? 3,
      pitch: data.pitch ?? 0,
      bearing: data.bearing ?? 0,
      attributionControl: { compact: true },
    });
    map.setProjection({ type: "globe" });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");

    map.on("load", () => {
      // 加水深柱体图层
      if (points.length > 0) {
        const features = points.map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
          properties: {
            depth: p.depth ?? 0,
            height:
              typeof p.depth === "number"
                ? Math.max(50, p.depth * extrudeScale)
                : 100,
            color:
              typeof p.depth === "number"
                ? depthColor(p.depth, depthRange)
                : "#3b82f6",
            label: p.label ?? "",
          },
        }));
        map.addSource("points", {
          type: "geojson",
          data: { type: "FeatureCollection", features },
        });
        // 柱体高度（3d-fill-extrusion 不能用 Point；用 fill-extrusion 需要 polygon）
        // 这里改用 circle 大小映射 depth，加上 case 强调
        map.addLayer({
          id: "points-glow",
          type: "circle",
          source: "points",
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["get", "depth"],
              depthRange[0],
              8,
              depthRange[1],
              28,
            ],
            "circle-color": ["get", "color"],
            "circle-opacity": 0.35,
            "circle-blur": 0.6,
          },
        });
        map.addLayer({
          id: "points-core",
          type: "circle",
          source: "points",
          paint: {
            "circle-radius": [
              "interpolate",
              ["linear"],
              ["get", "depth"],
              depthRange[0],
              5,
              depthRange[1],
              14,
            ],
            "circle-color": ["get", "color"],
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 1.5,
          },
        });
        // hover tooltip
        const popup = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 12,
        });
        map.on("mouseenter", "points-core", (e) => {
          map.getCanvas().style.cursor = "pointer";
          const f = e.features?.[0];
          if (!f) return;
          const props = f.properties as { depth: number; label: string };
          const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
          popup
            .setLngLat(coords)
            .setHTML(
              `<div style="font-size:12px;font-weight:700;margin-bottom:4px">${props.label || "未命名点"}</div>
               <div style="font-size:11px;color:#666">水深 <b>${props.depth.toFixed(2)} m</b></div>
               <div style="font-size:10.5px;color:#999;font-family:var(--font-mono)">${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}</div>`,
            )
            .addTo(map);
        });
        map.on("mouseleave", "points-core", () => {
          map.getCanvas().style.cursor = "";
          popup.remove();
        });

        // fit 视图
        if (!data.center && points.length > 1) {
          const bounds = new maplibregl.LngLatBounds();
          for (const p of points) bounds.extend([p.lon, p.lat]);
          map.fitBounds(bounds, { padding: 80, maxZoom: 9, duration: 800 });
        }
      }
      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{title ?? "三维地球"}</h2>
        <p style={{ color: "var(--text-3)" }}>
          在 frontmatter 设 <code>view: globe</code>，正文里放一段 fenced JSON：
        </p>
        <pre>
          <code>{`\`\`\`json
{
  "center": [114.305, 30.59],
  "zoom": 6,
  "pitch": 35,
  "depthRange": [0, 30],
  "points": [
    { "lat": 30.59, "lon": 114.30, "depth": 5,  "label": "码头 A" },
    { "lat": 30.65, "lon": 114.40, "depth": 18, "label": "排体 1" },
    { "lat": 30.72, "lon": 114.48, "depth": 27, "label": "深槽" }
  ]
}
\`\`\``}</code>
        </pre>
      </div>
    );
  }

  const flyHome = () => {
    const m = mapRef.current;
    if (!m || !data.center) return;
    m.flyTo({
      center: data.center,
      zoom: data.zoom ?? 3,
      pitch: data.pitch ?? 0,
      bearing: data.bearing ?? 0,
      duration: 1200,
    });
  };
  const tilt = () => {
    const m = mapRef.current;
    if (!m) return;
    const cur = m.getPitch();
    m.flyTo({ pitch: cur > 30 ? 0 : 55, duration: 800 });
  };
  const spin = () => {
    const m = mapRef.current;
    if (!m) return;
    m.flyTo({ bearing: (m.getBearing() + 90) % 360, duration: 1200 });
  };
  const projection = () => {
    const m = mapRef.current;
    if (!m) return;
    const cur = m.getProjection().type;
    m.setProjection({ type: cur === "globe" ? "mercator" : "globe" });
  };

  return (
    <div className="preview gb-view">
      <div className="gb-header">
        <div>
          <h1 className="gb-title">{title ?? "三维地球"}</h1>
          <div className="gb-meta">
            <span>{points.length} 个点</span>
            {hasDepth && (
              <>
                <span className="dot">·</span>
                <span>水深 {depthRange[0]}–{depthRange[1]} m</span>
              </>
            )}
            <span className="dot">·</span>
            <span>球面投影 · 卫星底图</span>
          </div>
        </div>
      </div>
      <div className="gb-board">
        <div ref={containerRef} className="gb-canvas" />
        <div className="gb-controls">
          <button type="button" onClick={flyHome} title="飞回初始视角">⟲ 回首页</button>
          <button type="button" onClick={tilt} title="切换倾斜角">⤢ 倾斜</button>
          <button type="button" onClick={spin} title="旋转 90°">↻ 旋转</button>
          <button type="button" onClick={projection} title="切换 球面/平面">🌐 投影</button>
        </div>
        {!ready && <div className="gb-loading">正在加载卫星底图…</div>}
      </div>
    </div>
  );
}
