// 按 key 索引的 setTimeout 容器：每个 key 同时只活一个 timer，schedule 同一
// key 会先 clear 旧的；timer 触发后自动从 Map 移除。
//
// 用于"按文件 / 按 workspace 节流"场景（fs-changed 防抖 RAG 重建、保存后
// token 刷新等）：避免在 workspace 被关闭时残留 pending 回调。
//
// 用法：
//   const timers = createKeyedTimers();
//   timers.schedule(key, () => doWork(), 2000);
//   timers.clearPrefix(`${ws}\0`);  // workspace 关闭时
//   timers.clearAll();              // 组件卸载时

export interface KeyedTimers {
  schedule(key: string, fn: () => void, ms: number): void;
  cancel(key: string): void;
  clearPrefix(prefix: string): void;
  clearAll(): void;
}

export function createKeyedTimers(): KeyedTimers {
  const map = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    schedule(key, fn, ms) {
      const prev = map.get(key);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        map.delete(key);
        fn();
      }, ms);
      map.set(key, timer);
    },
    cancel(key) {
      const t = map.get(key);
      if (t) {
        clearTimeout(t);
        map.delete(key);
      }
    },
    clearPrefix(prefix) {
      for (const [k, t] of map) {
        if (k.startsWith(prefix)) {
          clearTimeout(t);
          map.delete(k);
        }
      }
    },
    clearAll() {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    },
  };
}
