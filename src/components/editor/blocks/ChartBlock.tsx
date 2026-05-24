import { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { renderChartBlock } from "@/lib/charts";

interface RenderProps {
  block: {
    id: string;
    type: "chart";
    props: { code: string };
  };
  editor: {
    updateBlock: (
      block: { id: string },
      update: { props: { code: string } },
    ) => void;
  };
}

export const DEFAULT_CHART_CODE = [
  "{",
  '  "type": "bar",',
  '  "title": "月度趋势",',
  '  "labels": ["一月", "二月", "三月"],',
  '  "series": [',
  '    { "name": "收入", "data": [12, 18, 24] },',
  '    { "name": "成本", "data": [8, 11, 14] }',
  "  ]",
  "}",
].join("\n");

function ChartView({ block, editor }: RenderProps) {
  const code = block.props.code || DEFAULT_CHART_CODE;
  const [editing, setEditing] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) return;
    const host = hostRef.current;
    if (!host) return;
    host.className = "chart-block";
    host.removeAttribute("data-rendered");
    host.setAttribute("data-chart", encodeURIComponent(code));
    host.textContent = code;
    renderChartBlock(host);
  }, [code, editing]);

  return (
    <div className="bn-chart-block bn-preview-embed preview" contentEditable={false}>
      {editing ? (
        <textarea
          value={code}
          autoFocus
          spellCheck={false}
          rows={Math.max(8, code.split("\n").length + 1)}
          onChange={(e) =>
            editor.updateBlock(block, { props: { code: e.target.value } })
          }
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="bn-visual-source"
        />
      ) : (
        <div
          ref={hostRef}
          onDoubleClick={() => setEditing(true)}
          title="双击编辑"
        />
      )}
    </div>
  );
}

export const ChartReactBlock = createReactBlockSpec(
  {
    type: "chart",
    propSchema: {
      code: { default: DEFAULT_CHART_CODE },
    } as const,
    content: "none",
  },
  {
    render: ChartView as unknown as Parameters<
      typeof createReactBlockSpec
    >[1]["render"],
  },
);
