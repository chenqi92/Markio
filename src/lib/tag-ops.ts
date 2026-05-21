// 跨文件 #tag 重命名 / 合并。
// 调用方传入命中文件路径列表 + 旧 tag + 新 tag，按文件遍历：
//   open → 用 word-boundary 正则替换 → save。
// 任意一个文件保存失败时停下并把已改的 paths 列出来给调用方反馈。

import { api } from "./api";

export interface TagOpResult {
  /** 成功改并存盘的文件路径 */
  changed: string[];
  /** 没匹配到 / 内容不需要改的文件路径 */
  skipped: string[];
  /** 第一个失败的 (path, message)；存在表示流程因冲突或权限中断 */
  failed?: { path: string; message: string };
}

/** 把 #oldTag → #newTag。两侧避开 word / 其它 tag 字符，不动 `## heading`。 */
export function buildRenameRegex(oldTag: string): RegExp {
  const escaped = oldTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 前面不能是 `#`（避免 `##heading`）或 word char；后面不能是 tag 续接字符
  return new RegExp(
    `(?<![#\\w\\u4e00-\\u9fff])#${escaped}(?![\\w\\u4e00-\\u9fff./-])`,
    "g",
  );
}

/** 单文件改一次 tag 并存盘。回返 "changed" | "skipped" | 抛错。 */
async function renameInFile(
  path: string,
  re: RegExp,
  newToken: string,
): Promise<"changed" | "skipped"> {
  const opened = await api.open(path);
  re.lastIndex = 0;
  if (!re.test(opened.content)) {
    await api.close(path);
    return "skipped";
  }
  re.lastIndex = 0;
  const next = opened.content.replace(re, newToken);
  if (next === opened.content) {
    await api.close(path);
    return "skipped";
  }
  await api.save(path, next, opened.sig.mtime, opened.sig.hash);
  // 注意：rename 是后台批量操作，不接管 tab 的打开状态；
  // 文件如果当前在 tab 里打开，下次外部 fs-changed 事件会触发 tab 提示 (existing flow)
  await api.close(path);
  return "changed";
}

/** 跨多个文件把 `#oldTag` 改成 `#newTag`（合并 = newTag 已存在的场景）。 */
export async function renameTag(
  paths: string[],
  oldTag: string,
  newTag: string,
): Promise<TagOpResult> {
  const re = buildRenameRegex(oldTag);
  const newToken = `#${newTag}`;
  const result: TagOpResult = { changed: [], skipped: [] };
  for (const p of paths) {
    try {
      const outcome = await renameInFile(p, re, newToken);
      if (outcome === "changed") result.changed.push(p);
      else result.skipped.push(p);
    } catch (e) {
      result.failed = { path: p, message: (e as Error).message };
      return result;
    }
  }
  return result;
}
