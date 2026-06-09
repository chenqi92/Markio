import { useEffect, useState } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { deleteBeforeCursor } from "@/lib/editor-bridge";
import { markdownCommands, CHART_TYPES } from "@/lib/markdown-commands";

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
        markdownCommands.h1();
      },
    },
    {
      id: "h2",
      mark: "H2",
      ttl: "二级标题",
      sub: "## 标题",
      run: () => {
        finish();
        markdownCommands.h2();
      },
    },
    {
      id: "h3",
      mark: "H3",
      ttl: "三级标题",
      sub: "### 标题",
      run: () => {
        finish();
        markdownCommands.h3();
      },
    },
    {
      id: "h4",
      mark: "H4",
      ttl: "四级标题",
      sub: "#### 标题",
      run: () => {
        finish();
        markdownCommands.h4();
      },
    },
    {
      id: "h5",
      mark: "H5",
      ttl: "五级标题",
      sub: "##### 标题",
      run: () => {
        finish();
        markdownCommands.h5();
      },
    },
    {
      id: "todo",
      icon: "check-square",
      ttl: "待办事项",
      sub: "可勾选清单",
      run: () => {
        finish();
        markdownCommands.taskList();
      },
    },
    {
      id: "bullet",
      icon: "list",
      ttl: "无序列表",
      sub: "- 项目",
      run: () => {
        finish();
        markdownCommands.bulletList();
      },
    },
    {
      id: "quote",
      icon: "quote",
      ttl: "引用块",
      sub: "缩进引用",
      run: () => {
        finish();
        markdownCommands.quote();
      },
    },
    {
      id: "link",
      icon: "link",
      ttl: "链接",
      sub: "[文本](URL)",
      run: () => {
        finish();
        markdownCommands.link();
      },
    },
    {
      id: "image",
      icon: "image",
      ttl: "图片",
      sub: "![alt](URL)",
      run: () => {
        finish();
        markdownCommands.image();
      },
    },
    {
      id: "code",
      icon: "code",
      ttl: "代码块",
      sub: "支持 90+ 语言高亮",
      run: () => {
        finish();
        markdownCommands.codeBlock();
      },
    },
    {
      id: "table",
      icon: "table",
      ttl: "表格",
      sub: "插入 3 × 3 表格",
      run: () => {
        finish();
        markdownCommands.table();
      },
    },
    {
      id: "selection-to-table",
      icon: "table",
      ttl: "文本转表格",
      sub: "将 TSV / CSV / 管道分隔文本转为表格",
      run: () => {
        finish();
        markdownCommands.selectionToTable();
      },
    },
    {
      id: "callout",
      icon: "info",
      ttl: "提示块",
      sub: "info / warn / tip",
      run: () => {
        finish();
        markdownCommands.callout();
      },
    },
    {
      id: "math",
      mark: "∑",
      ttl: "数学公式",
      sub: "LaTeX 语法",
      run: () => {
        finish();
        markdownCommands.mathBlock();
      },
    },
    {
      id: "mermaid",
      mark: "◇",
      ttl: "Mermaid 流程图",
      sub: "graph / sequence / gantt",
      run: () => {
        finish();
        markdownCommands.mermaid();
      },
    },
    ...CHART_TYPES.map((t) => ({
      id: `chart-${t.id}`,
      icon: t.icon,
      ttl: `图表 · ${t.label}`,
      sub: t.sub,
      run: () => {
        finish();
        markdownCommands.chartType(t.id);
      },
    })),
    {
      id: "server",
      mark: "🔒",
      ttl: "服务器 / 凭据",
      sub: "IP / 端口 / 账号密码，可点击连接",
      run: () => {
        finish();
        markdownCommands.serverBlock();
      },
    },
    {
      id: "graphviz",
      icon: "diagram",
      ttl: "Graphviz / DOT",
      sub: "本地渲染节点关系图",
      run: () => {
        finish();
        markdownCommands.graphviz();
      },
    },
    {
      id: "plantuml",
      mark: "PU",
      ttl: "PlantUML",
      sub: "需配置 PlantUML server",
      run: () => {
        finish();
        markdownCommands.plantuml();
      },
    },
    {
      id: "wiki",
      icon: "link",
      ttl: "双向链接",
      sub: "[[ 引用其它笔记",
      run: () => {
        finish();
        markdownCommands.wikiLink();
      },
    },
    {
      id: "footnote",
      mark: "[1]",
      ttl: "脚注定义",
      sub: "[^1]: 内容",
      run: () => {
        finish();
        markdownCommands.footnote();
      },
    },
    {
      id: "hr",
      mark: "—",
      ttl: "分割线",
      sub: "---",
      run: () => {
        finish();
        markdownCommands.horizontalRule();
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
