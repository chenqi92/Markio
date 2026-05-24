import { useEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { renderDiagramBlock } from "@/lib/diagrams";

type DiagramKind = "graphviz" | "plantuml";

interface RenderProps {
  block: {
    id: string;
    type: "diagram";
    props: { kind: DiagramKind; code: string; server: string };
  };
  editor: {
    updateBlock: (
      block: { id: string },
      update: { props: Partial<{ kind: DiagramKind; code: string; server: string }> },
    ) => void;
  };
}

export const DEFAULT_DOT_CODE = "digraph G {\n  A -> B\n}";
export const DEFAULT_PLANTUML_CODE = "@startuml\nA -> B: message\n@enduml";

function DiagramView({ block, editor }: RenderProps) {
  const kind = block.props.kind === "plantuml" ? "plantuml" : "graphviz";
  const code =
    block.props.code ||
    (kind === "plantuml" ? DEFAULT_PLANTUML_CODE : DEFAULT_DOT_CODE);
  const server = block.props.server ?? "";
  const [editing, setEditing] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) return;
    const host = hostRef.current;
    if (!host) return;
    host.className = kind === "plantuml" ? "plantuml-block" : "graphviz-block";
    host.removeAttribute("data-rendered");
    host.removeAttribute("data-graphviz");
    host.removeAttribute("data-plantuml");
    host.removeAttribute("data-plantuml-server");
    host.setAttribute(
      kind === "plantuml" ? "data-plantuml" : "data-graphviz",
      encodeURIComponent(code),
    );
    if (kind === "plantuml" && server.trim()) {
      host.setAttribute("data-plantuml-server", server.trim());
    }
    host.textContent = code;
    void renderDiagramBlock(host);
  }, [code, editing, kind, server]);

  return (
    <div className="bn-diagram-block bn-preview-embed preview" contentEditable={false}>
      {editing ? (
        <div className="bn-visual-editor">
          <select
            value={kind}
            onChange={(e) =>
              editor.updateBlock(block, {
                props: {
                  kind: e.target.value === "plantuml" ? "plantuml" : "graphviz",
                },
              })
            }
          >
            <option value="graphviz">Graphviz / DOT</option>
            <option value="plantuml">PlantUML</option>
          </select>
          {kind === "plantuml" && (
            <input
              value={server}
              placeholder="PlantUML server"
              spellCheck={false}
              onChange={(e) =>
                editor.updateBlock(block, { props: { server: e.target.value } })
              }
            />
          )}
          <textarea
            value={code}
            autoFocus
            spellCheck={false}
            rows={Math.max(5, code.split("\n").length + 1)}
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
        </div>
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

export const DiagramReactBlock = createReactBlockSpec(
  {
    type: "diagram",
    propSchema: {
      kind: { default: "graphviz" },
      code: { default: DEFAULT_DOT_CODE },
      server: { default: "" },
    } as const,
    content: "none",
  },
  {
    render: DiagramView as unknown as Parameters<
      typeof createReactBlockSpec
    >[1]["render"],
  },
);
