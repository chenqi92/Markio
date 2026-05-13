import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useFileIcons } from "@/stores/fileIcons";

const SYMBOLS: Array<{ name: IconName; label: string }> = [
  { name: "note", label: "笔记" },
  { name: "file", label: "文件" },
  { name: "folder", label: "文件夹" },
  { name: "folder-open", label: "打开文件夹" },
  { name: "calendar", label: "日记" },
  { name: "book", label: "读书" },
  { name: "target", label: "目标" },
  { name: "check-square", label: "待办" },
  { name: "list", label: "列表" },
  { name: "table", label: "表格" },
  { name: "image", label: "图片" },
  { name: "link", label: "链接" },
  { name: "tag", label: "标签" },
  { name: "hash", label: "主题" },
  { name: "lightbulb", label: "灵感" },
  { name: "palette", label: "设计" },
  { name: "archive", label: "归档" },
  { name: "database", label: "资料库" },
  { name: "cloud", label: "同步" },
  { name: "sparkle", label: "AI" },
  { name: "message", label: "消息" },
  { name: "code", label: "代码" },
  { name: "clock", label: "时间" },
  { name: "flame", label: "连续写作" },
];

export function IconPicker({
  x,
  y,
  path,
  onClose,
}: {
  x: number;
  y: number;
  path: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useFileIcons((s) => s.icons[path]);
  const set = useFileIcons((s) => s.set);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") onClose();
    });
    return () => window.removeEventListener("mousedown", onClick);
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 320);
  const top = Math.min(y, window.innerHeight - 320);

  return (
    <div className="iconpicker" style={{ left, top }} ref={ref}>
      <div className="iconpicker-h">
        <span style={{ flex: 1, fontWeight: 600 }}>更改图标</span>
        <button type="button" onClick={onClose}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="iconpicker-body">
        <div className="symbol-grid">
          {SYMBOLS.map((s) => (
            <button
              type="button"
              key={s.name}
              title={s.label}
              className={"symbol-cell" + (s.name === current ? " active" : "")}
              onClick={() => {
                set(path, s.name);
                onClose();
              }}
            >
              <Icon name={s.name} size={18} />
            </button>
          ))}
        </div>
      </div>
      <div className="iconpicker-footer">
        <button
          type="button"
          className="link-btn danger"
          onClick={() => {
            set(path, null);
            onClose();
          }}
        >
          恢复默认
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="settings-btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
