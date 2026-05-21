// 分屏滚动同步：源码侧 ↔ 预览侧，纯命令式 DOM 操作，不走 React state。
//
// 之前的实现把每次 scroll 都 setState({scrollTarget}) 触发 React 重新渲染再
// 由 useEffect 里同步 scrollTop，看起来很「干净」但有两个坑：
//   1. CodeMirror 在 wysiwyg / fontSize 切换时会重建 extensions，整段
//      EditorView.domEventHandlers({scroll}) 会在某些时序下不收到事件。
//   2. setState 改 nonce → React 重渲染 → useEffect 比较 deps → applyScrollTarget
//      这条链路任何一环（memo、prop 身份变化、render 时序）出问题，同步就静默失效。
//
// 改成单例总线之后，两侧只负责注册 / 注销自己的 scrollDOM + 取 / 写「视口顶部
// 对应的源码行号」的能力。每次 scroll 直接读 origin pane 的 top line，写到对端，
// 没有任何 React 介入。lock 用 timer 防互相 echo 触发，timer 时间略长于浏览器
// 自身派发 scroll 事件的窗口（macOS WebKit 偶尔异步在下一帧后才派发，所以选 180ms）。

export interface PaneHandle {
  /** 真正的 scroll 元素（CM 的 scrollDOM 或 .preview-pane）。 */
  el: HTMLElement;
  /** 取视口顶部对应的（分数）源码行号；anchors / 探针不可用时返回 null。 */
  getTopLine: () => number | null;
  /** 把视口顶部对齐到指定源码行号（分数）。返回 false 表示当前无法按行同步。 */
  setTopLine: (line: number) => boolean | void;
  /** 兜底：取 scrollTop / (scrollHeight - clientHeight)。 */
  getRatio: () => number;
  /** 兜底：按比例写 scrollTop。 */
  setRatio: (ratio: number) => void;
}

type Role = "source" | "preview";

interface Slot {
  pane: PaneHandle;
  detach: () => void;
}

const slots: Record<Role, Slot | null> = { source: null, preview: null };

let lock: Role | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
const LOCK_MS = 180;

function setLock(role: Role) {
  lock = role;
  if (lockTimer != null) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => {
    lock = null;
    lockTimer = null;
  }, LOCK_MS);
}

function other(role: Role): Role {
  return role === "source" ? "preview" : "source";
}

function syncFrom(origin: Role) {
  // origin 自己刚刚被对端写过，scroll 事件回声 → 屏蔽
  if (lock === origin) return;
  const src = slots[origin]?.pane;
  const dstSlot = slots[other(origin)];
  if (!src || !dstSlot) return;
  // 写对端前先把对端锁住，这样对端 scroll 事件回声就会被上面那行 return 掉
  setLock(other(origin));
  const line = src.getTopLine();
  if (line != null && Number.isFinite(line)) {
    const ok = dstSlot.pane.setTopLine(line);
    if (ok !== false) return;
  }
  dstSlot.pane.setRatio(src.getRatio());
}

export function registerPane(role: Role, pane: PaneHandle | null): void {
  const existing = slots[role];
  if (existing) {
    existing.detach();
    slots[role] = null;
  }
  if (!pane) return;
  const handler = () => syncFrom(role);
  pane.el.addEventListener("scroll", handler, { passive: true });
  slots[role] = {
    pane,
    detach: () => pane.el.removeEventListener("scroll", handler),
  };
}

/** 测试 / 切到非分屏视图时手动清场。 */
export function resetSplitScrollSync(): void {
  for (const role of ["source", "preview"] as Role[]) {
    slots[role]?.detach();
    slots[role] = null;
  }
  lock = null;
  if (lockTimer != null) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
}
