import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import type { Core } from "cytoscape";
import { useTabs } from "@/stores/tabs";

interface GraphNode {
  id: number;
  path: string;
  inDegree: number;
  outDegree: number;
}

interface GraphEdge {
  from: number;
  to: number;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  height?: number;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? p;
}

/** Cytoscape 渲染 RAG 链接图；节点点击 → 在编辑器中打开对应笔记。 */
export function RagGraphMini({ nodes, edges, height = 320 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const openPath = useTabs((s) => s.openPath);

  useEffect(() => {
    if (!hostRef.current) return;
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }
    if (nodes.length === 0) return;

    const elements: cytoscape.ElementDefinition[] = [];
    const validIds = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      elements.push({
        data: {
          id: String(n.id),
          label: basename(n.path),
          path: n.path,
          inDeg: n.inDegree,
          weight: 6 + Math.sqrt(n.inDegree + n.outDegree) * 4,
        },
      });
    }
    for (const e of edges) {
      if (!validIds.has(e.from) || !validIds.has(e.to)) continue;
      elements.push({
        data: {
          id: `e-${e.from}-${e.to}`,
          source: String(e.from),
          target: String(e.to),
        },
      });
    }

    const cy = cytoscape({
      container: hostRef.current,
      elements,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#60a5fa",
            label: "data(label)",
            "font-size": 10,
            color: "#1d1d1f",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-outline-color": "#fff",
            "text-outline-width": 2,
            width: "data(weight)",
            height: "data(weight)",
            "border-width": 1,
            "border-color": "#3b82f6",
          },
        },
        {
          selector: "node[inDeg >= 5]",
          style: {
            "background-color": "#f97316",
            "border-color": "#ea580c",
          },
        },
        {
          selector: "edge",
          style: {
            width: 1,
            "line-color": "#cbd5e1",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#cbd5e1",
            "arrow-scale": 0.6,
          },
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#0a84ff",
            "border-color": "#0a84ff",
          },
        },
      ],
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: () => 4500,
        idealEdgeLength: () => 80,
        padding: 16,
      } as cytoscape.LayoutOptions,
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 2.5,
    });

    cy.on("tap", "node", (evt) => {
      const path = evt.target.data("path") as string;
      if (path) void openPath(path);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, openPath]);

  return (
    <div
      ref={hostRef}
      style={{
        height,
        margin: "0 16px 12px",
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 8,
        background: "var(--bg-2, #fafafa)",
      }}
    />
  );
}
