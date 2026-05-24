/**
 * 切除某个 workspace 关联的后台资源（定时器 / 索引任务等）。
 *
 * tabs.ts、App.tsx 等需要在 workspace 移除时清理状态的模块，在自己加载时调用
 * registerWorkspaceCleanup 注册回调；workspace.ts 在 removeWorkspace 末尾调用
 * runWorkspaceCleanups 触发全部回调。
 *
 * 这层 indirection 用来打破循环依赖：workspace ← tabs，而 workspace 又想调
 * tabs 的清理函数。之前用 `void import("./tabs")` 动态 import 绕开循环，但
 * Vite 看到同模块也有静态 import 后会提示拆包失效；改成 registry 后双向都是
 * 静态 import 单向流（workspace → registry，tabs → registry），无循环。
 */
type WorkspaceCleanupFn = (workspacePath: string) => void;

const cleanups: WorkspaceCleanupFn[] = [];

export function registerWorkspaceCleanup(fn: WorkspaceCleanupFn): void {
  cleanups.push(fn);
}

export function runWorkspaceCleanups(workspacePath: string): void {
  for (const fn of cleanups) {
    try {
      fn(workspacePath);
    } catch (err) {
      console.warn("[workspaceCleanup] callback failed", err);
    }
  }
}
