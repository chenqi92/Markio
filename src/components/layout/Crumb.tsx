import { crumbSegments } from "@/lib/utils";
import { useWorkspace } from "@/stores/workspace";
import { useTabs } from "@/stores/tabs";

export function Crumb() {
  const ws = useWorkspace((s) => s.activeWorkspace());
  const tab = useTabs((s) => s.activeTab());
  if (!ws || !tab) return null;
  const segs = crumbSegments(ws.path, tab.path);
  if (segs.length === 0) return null;
  return (
    <div className="crumb" title={tab.path}>
      {segs.map((s, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
          <span className={"seg" + (i === segs.length - 1 ? " current" : "")}>{s}</span>
          {i < segs.length - 1 && <span className="sep">›</span>}
        </span>
      ))}
    </div>
  );
}
