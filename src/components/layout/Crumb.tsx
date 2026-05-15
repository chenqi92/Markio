import { crumbSegments } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";

export function Crumb() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tabPath = useTabs((s) => {
    const id = s.activeId;
    return id ? s.tabs.find((t) => t.id === id)?.path : undefined;
  });
  if (!ws || !tabPath) return null;
  const segs = crumbSegments(ws.path, tabPath);
  if (segs.length === 0) return null;
  return (
    <div className="crumb" title={tabPath}>
      {segs.map((s, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
          <span className={"seg" + (i === segs.length - 1 ? " current" : "")}>{s}</span>
          {i < segs.length - 1 && <span className="sep">›</span>}
        </span>
      ))}
    </div>
  );
}
