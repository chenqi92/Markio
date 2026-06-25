// 日记（Daily Note）：约定路径 `<workspace>/Daily/YYYY-MM-DD.md`，与 QuickCapture
// 的「今日 Daily」目标、note-templates 的 daily 模板一致。打开命令 / 快捷键复用此处。

import { api, parseError } from "@/lib/api";
import { NOTE_TEMPLATES } from "@/lib/note-templates";
import { useTabs } from "@/stores/tabs";
import { useUI } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 某日期的日记绝对路径。 */
export function dailyNotePath(workspace: string, d: Date): string {
  return `${workspace}/Daily/${ymd(d)}.md`;
}

const DAILY_FILE_RE = /(\d{4})-(\d{2})-(\d{2})\.md$/i;

/** 从路径解析日记日期；非 `Daily/YYYY-MM-DD.md` 返回 null。 */
function dailyDateFromPath(path: string): Date | null {
  const norm = path.replace(/\\/g, "/");
  if (!/\/daily\//i.test(norm)) return null;
  const m = DAILY_FILE_RE.exec(norm);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * 打开当前仓库里某天的日记；不存在则按 daily 模板新建（顺带建出 Daily/ 目录）。
 * date 省略时为今天。可从命令面板 / 快捷键 / 其它任意处直接调用（走 getState）。
 */
export async function openDailyNote(date?: Date): Promise<void> {
  const { setToast } = useUI.getState();
  const ws = useWorkspace.getState().activeWorkspace();
  if (!ws) {
    setToast({ stage: "error", message: "请先打开一个仓库" }, 2000);
    return;
  }
  const d = date ?? new Date();
  const path = dailyNotePath(ws.path, d);
  const tmpl = NOTE_TEMPLATES.find((t) => t.id === "daily");
  const body = tmpl ? tmpl.build(d) : `# ${ymd(d)} · Daily\n\n`;

  try {
    // createNew 已存在会抛 ALREADY_EXISTS；其父目录由后端 create_dir_all 补齐。
    await api.createNew(path, body);
    await useWorkspace.getState().refreshTree(ws.id);
  } catch (err) {
    const e2 = parseError(err);
    if (e2.code !== "ALREADY_EXISTS") {
      setToast({ stage: "error", message: `打开日记失败：${e2.message}` }, 2500);
      return;
    }
    // 已存在 → 直接打开
  }

  try {
    await useTabs.getState().openFile(ws.id, path);
  } catch (e) {
    setToast({ stage: "error", message: `打开日记失败：${(e as Error).message}` }, 2500);
  }
}

/**
 * 打开相对「当前日记（按文件名解析）或今天」偏移 delta 天的日记。
 * delta=-1 前一天、+1 后一天。
 */
export async function openDailyRelative(delta: number): Promise<void> {
  const id = useTabs.getState().activeId;
  const tab = id ? useTabs.getState().tabs.find((t) => t.id === id) : undefined;
  let ref: Date | null = tab?.path ? dailyDateFromPath(tab.path) : null;
  if (!ref) ref = new Date();
  const next = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + delta);
  await openDailyNote(next);
}
