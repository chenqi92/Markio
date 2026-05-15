import { useEffect, useMemo, useRef, useState } from "react";

interface Point {
  lat: number;
  lon: number;
  /** 水深 (m)；柱体高度按 depth*extrudeScale 计算，颜色按 depthRange 映射 */
  depth?: number;
  label?: string;
  desc?: string;
}

interface CesiumData {
  center?: [number, number];
  /** 相机高度 (m)；缺省 100000 = 100km */
  altitude?: number;
  pitch?: number;
  heading?: number;
  points?: Point[];
  depthRange?: [number, number];
  /** 柱体高度的视觉放大系数，米→米。缺省 200。深 25m → 柱高 5000m */
  extrudeScale?: number;
  /** 底图：osm 免 key | bing 需要 Cesium ion 默认 token */
  imagery?: "osm" | "bing" | "esri";
}

interface Props {
  body: string;
  title?: string;
}

function parseData(body: string): CesiumData | null {
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    if (v && typeof v === "object") return v as CesiumData;
  } catch {
    /* ignore */
  }
  return null;
}

function depthColor(depth: number, range: [number, number]) {
  const [lo, hi] = range;
  const t = Math.max(0, Math.min(1, (depth - lo) / Math.max(1e-3, hi - lo)));
  const stops = [
    [253, 224, 71],
    [251, 146, 60],
    [220, 38, 38],
    [88, 28, 135],
  ];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    (a[0] + (b[0] - a[0]) * f) / 255,
    (a[1] + (b[1] - a[1]) * f) / 255,
    (a[2] + (b[2] - a[2]) * f) / 255,
  ] as [number, number, number];
}

// 防止重复 init Cesium —— 同进程多个 CesiumView 共用
let cesiumLoaded: Promise<typeof import("cesium")> | null = null;
async function loadCesium() {
  if (!cesiumLoaded) {
    cesiumLoaded = import("cesium").then((mod) => {
      // 关闭 ion token 校验（用 OSM 时不需要）
      // @ts-expect-error 运行时字段
      window.CESIUM_BASE_URL = window.CESIUM_BASE_URL ?? "/cesium/";
      return mod;
    });
  }
  return cesiumLoaded;
}

export function CesiumView({ body, title }: Props) {
  const data = useMemo(() => parseData(body), [body]);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const points = data?.points ?? [];
  const depthRange: [number, number] = data?.depthRange ?? [0, 50];
  const extrudeScale = data?.extrudeScale ?? 200;
  const hasDepth = points.some((p) => typeof p.depth === "number");

  useEffect(() => {
    if (!containerRef.current || !data) return;
    let viewerLocal: unknown = null;
    let cancelled = false;
    void (async () => {
      try {
        const Cesium = await loadCesium();
        if (cancelled || !containerRef.current) return;

        // 计算镜头中心
        let center: [number, number];
        if (data.center) center = data.center;
        else if (points.length > 0) {
          const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
          const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
          center = [lon, lat];
        } else center = [114.305, 30.59];

        // 底图：默认 OSM，不依赖 Cesium ion token
        const imageryKind = data.imagery ?? "osm";
        const imagery =
          imageryKind === "esri"
            ? new Cesium.UrlTemplateImageryProvider({
                url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                credit: "Imagery © Esri",
                maximumLevel: 18,
              })
            : new Cesium.UrlTemplateImageryProvider({
                url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                credit: "© OpenStreetMap contributors",
                maximumLevel: 19,
                subdomains: ["a", "b", "c"],
              });

        const viewer = new Cesium.Viewer(containerRef.current, {
          baseLayer: Cesium.ImageryLayer.fromProviderAsync(
            Promise.resolve(imagery),
            {},
          ),
          baseLayerPicker: false,
          geocoder: false,
          homeButton: true,
          sceneModePicker: true,
          navigationHelpButton: false,
          animation: false,
          timeline: false,
          fullscreenButton: true,
          shouldAnimate: true,
        });
        viewerLocal = viewer;
        viewerRef.current = viewer;
        // 隐藏左下版权浮窗（保留小角标）
        if (viewer.cesiumWidget?.creditContainer instanceof HTMLElement) {
          (viewer.cesiumWidget.creditContainer as HTMLElement).style.display =
            "none";
        }
        // 关掉双击锁定相机的烦人交互
        viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
          Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
        );

        // 放点位 & 柱体
        for (const p of points) {
          const c = typeof p.depth === "number" ? depthColor(p.depth, depthRange) : [0.23, 0.51, 0.96];
          const cesiumColor = new Cesium.Color(c[0], c[1], c[2], 0.85);
          const heightM =
            typeof p.depth === "number" ? Math.max(50, p.depth * extrudeScale) : 0;
          viewer.entities.add({
            id: `pt-${p.lon}-${p.lat}`,
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, heightM / 2),
            cylinder:
              heightM > 0
                ? {
                    length: heightM,
                    topRadius: 80 + (p.depth ?? 0) * 5,
                    bottomRadius: 80 + (p.depth ?? 0) * 5,
                    material: cesiumColor,
                    outline: true,
                    outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
                  }
                : undefined,
            point:
              heightM === 0
                ? {
                    pixelSize: 12,
                    color: cesiumColor,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2,
                  }
                : undefined,
            label: p.label
              ? {
                  text: p.label,
                  font: "12px sans-serif",
                  pixelOffset: new Cesium.Cartesian2(0, -22),
                  fillColor: Cesium.Color.WHITE,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 2,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  showBackground: true,
                  backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
                  backgroundPadding: new Cesium.Cartesian2(6, 4),
                  verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                }
              : undefined,
            description: p.desc
              ? `<div>水深 <b>${(p.depth ?? 0).toFixed(2)} m</b></div><div>${p.desc}</div>`
              : `<div>水深 <b>${(p.depth ?? 0).toFixed(2)} m</b></div>`,
          });
        }

        // 飞到目标视角
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            center[0],
            center[1],
            data.altitude ?? 100_000,
          ),
          orientation: {
            heading: Cesium.Math.toRadians(data.heading ?? 0),
            pitch: Cesium.Math.toRadians(-(data.pitch ?? 45)),
            roll: 0,
          },
          duration: 1.5,
        });

        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setErrMsg((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      const v = viewerLocal as { destroy?: () => void; isDestroyed?: () => boolean } | null;
      if (v && (!v.isDestroyed || !v.isDestroyed())) {
        v.destroy?.();
      }
      viewerRef.current = null;
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) {
    return (
      <div className="preview" style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{title ?? "Cesium 3D"}</h2>
        <p style={{ color: "var(--text-3)" }}>
          在 frontmatter 设 <code>view: cesium</code>，正文 fenced JSON：
        </p>
        <pre>
          <code>{`\`\`\`json
{
  "center": [114.305, 30.59],
  "altitude": 50000,
  "pitch": 50,
  "depthRange": [0, 30],
  "extrudeScale": 200,
  "imagery": "esri",
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
    <div className="preview cs-view">
      <div className="cs-header">
        <div>
          <h1 className="cs-title">{title ?? "Cesium 3D"}</h1>
          <div className="cs-meta">
            <span>{points.length} 个点</span>
            {hasDepth && (
              <>
                <span className="dot">·</span>
                <span>水深 {depthRange[0]}–{depthRange[1]} m · 柱体放大 ×{extrudeScale}</span>
              </>
            )}
            <span className="dot">·</span>
            <span>Cesium · {data.imagery ?? "osm"}</span>
          </div>
        </div>
      </div>
      <div className="cs-board">
        <div ref={containerRef} className="cs-canvas" />
        {status === "loading" && (
          <div className="cs-loading">正在加载 Cesium 引擎（首次约 5s）…</div>
        )}
        {status === "error" && (
          <div className="cs-loading" style={{ color: "#fca5a5" }}>
            Cesium 加载失败：{errMsg ?? "unknown"}
          </div>
        )}
      </div>
    </div>
  );
}
