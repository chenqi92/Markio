import { useEffect, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { deleteBeforeCursor, insertBlock, prefixLine } from "@/lib/editor-bridge";

interface Item {
  id: string;
  icon?: IconName;
  mark?: string;
  ttl: string;
  sub: string;
  run: () => void;
}

const ITEMS = (close: () => void): Item[] => {
  const finish = () => {
    deleteBeforeCursor(1); // 吃掉触发用的 `/`
    close();
  };
  return [
    {
      id: "h1",
      mark: "H1",
      ttl: "一级标题",
      sub: "# 标题",
      run: () => {
        finish();
        prefixLine("# ");
      },
    },
    {
      id: "h2",
      mark: "H2",
      ttl: "二级标题",
      sub: "## 标题",
      run: () => {
        finish();
        prefixLine("## ");
      },
    },
    {
      id: "h3",
      mark: "H3",
      ttl: "三级标题",
      sub: "### 标题",
      run: () => {
        finish();
        prefixLine("### ");
      },
    },
    {
      id: "todo",
      icon: "check-square",
      ttl: "待办事项",
      sub: "可勾选清单",
      run: () => {
        finish();
        prefixLine("- [ ] ");
      },
    },
    {
      id: "bullet",
      icon: "list",
      ttl: "无序列表",
      sub: "- 项目",
      run: () => {
        finish();
        prefixLine("- ");
      },
    },
    {
      id: "quote",
      icon: "quote",
      ttl: "引用块",
      sub: "缩进引用",
      run: () => {
        finish();
        prefixLine("> ");
      },
    },
    {
      id: "code",
      icon: "code",
      ttl: "代码块",
      sub: "支持 90+ 语言高亮",
      run: () => {
        finish();
        insertBlock("\n```\n\n```\n", { atLineStart: true });
      },
    },
    {
      id: "table",
      icon: "table",
      ttl: "表格",
      sub: "插入 3 × 3 表格",
      run: () => {
        finish();
        insertBlock(
          "\n| 列 A | 列 B | 列 C |\n| --- | --- | --- |\n| | | |\n",
          { atLineStart: true },
        );
      },
    },
    {
      id: "callout",
      icon: "info",
      ttl: "提示块",
      sub: "info / warn / tip",
      run: () => {
        finish();
        insertBlock("\n> [!TIP]\n> ", { atLineStart: true });
      },
    },
    {
      id: "math",
      mark: "∑",
      ttl: "数学公式",
      sub: "LaTeX 语法",
      run: () => {
        finish();
        insertBlock("\n$$\n\n$$\n", { atLineStart: true });
      },
    },
    {
      id: "mermaid",
      mark: "◇",
      ttl: "Mermaid 流程图",
      sub: "graph / sequence / gantt",
      run: () => {
        finish();
        insertBlock("\n```mermaid\ngraph LR\n  A --> B\n```\n", {
          atLineStart: true,
        });
      },
    },
    {
      id: "wiki",
      icon: "link",
      ttl: "双向链接",
      sub: "[[ 引用其它笔记",
      run: () => {
        finish();
        insertBlock("[[]] ", {});
      },
    },
    {
      id: "hr",
      mark: "—",
      ttl: "分割线",
      sub: "---",
      run: () => {
        finish();
        insertBlock("\n---\n", { atLineStart: true });
      },
    },
  ];
};

export function SlashMenu({
  x,
  y,
  onClose,
}: {
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const all = ITEMS(onClose);
  const items = q
    ? all.filter((i) => i.ttl.includes(q) || i.id.includes(q.toLowerCase()))
    : all;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(items.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        items[sel]?.run();
      } else if (e.key === "Backspace" && q === "") {
        // 用户在空查询时按退格 → 关闭
        onClose();
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setQ((s) => s + e.key);
      } else if (e.key === "Backspace") {
        setQ((s) => s.slice(0, -1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [items, sel, q, onClose]);

  // clamp 在视口内
  const left = Math.min(x, window.innerWidth - 300);
  const top = Math.min(y + 4, window.innerHeight - 320);

  return (
    <div className="slash" style={{ left, top }}>
      <div className="slash-hd">
        <span>/</span>
        <span>插入 {q && `· ${q}`}</span>
        <span style={{ marginLeft: "auto", fontWeight: 500 }}>
          {items.length} 个
        </span>
      </div>
      <div className="slash-list scroll">
        {items.length === 0 ? (
          <div
            style={{
              padding: 18,
              color: "var(--text-3)",
              textAlign: "center",
              fontSize: 11.5,
            }}
          >
            没有匹配项
          </div>
        ) : (
          items.map((it, ix) => (
            <button
              type="button"
              key={it.id}
              className={"slash-item" + (ix === sel ? " sel" : "")}
              onClick={() => it.run()}
              onMouseEnter={() => setSel(ix)}
            >
              <span className="ico">
                {it.icon ? <Icon name={it.icon} size={13} /> : it.mark}
              </span>
              <div style={{ flex: 1 }}>
                <div className="ttl">{it.ttl}</div>
                <div className="sub">{it.sub}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
