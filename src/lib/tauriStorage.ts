/**
 * tauri-plugin-store 适配器。
 *
 * 桌面端：所有 zustand persist store 共享一个 store.bin，存在 app_data_dir/markio/。
 * 浏览器开发：回退到 localStorage，保持开发体验。
 *
 * 启动流程：main.tsx 先 await preloadTauriStorage() 把 store.bin 全量读进内存 cache，
 * 然后 await 各 store.persist.rehydrate() 同步水合（cache 是同步可读的）；
 * 之后 React 才 render，避免主题闪烁。
 *
 * 写入：cache 立即更新（同步），plugin-store 用串行队列异步写盘（autoSave 100ms 防抖）。
 */
import { Store } from "@tauri-apps/plugin-store";
import type { StateStorage } from "zustand/middleware";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const STORE_FILE = "store.bin";

/** 所有 persist store 的 key（用于 localStorage → plugin-store 迁移）。 */
const PERSISTED_KEYS = [
  "markio.settings.v1",
  "markio.workspaces.v1",
  "markio.ui.v1",
  "markio.aiSessions.v1",
  "markio.pomodoro.v1",
  "markio.streak.v1",
  "markio.recents.v1",
  "markio.pinned-plan.v1",
  "markio.fileIcons.v1",
] as const;

let store: Store | null = null;
const cache = new Map<string, string>();
let writeQueue: Promise<void> = Promise.resolve();

export async function preloadTauriStorage(): Promise<void> {
  if (!isTauri()) return;
  try {
    store = await Store.load(STORE_FILE, { autoSave: 100, defaults: {} });
    const entries = await store.entries<string>();
    for (const [k, v] of entries) {
      if (typeof v === "string") cache.set(k, v);
    }
    // 一次性把旧 localStorage 里的值搬过来
    let migrated = false;
    for (const name of PERSISTED_KEYS) {
      if (cache.has(name)) continue;
      const legacy = localStorage.getItem(name);
      if (legacy != null) {
        cache.set(name, legacy);
        await store.set(name, legacy);
        localStorage.removeItem(name);
        migrated = true;
      }
    }
    if (migrated) await store.save();
  } catch (e) {
    console.error("[tauriStorage] preload failed", e);
  }
}

function enqueueWrite(task: () => Promise<unknown>) {
  writeQueue = writeQueue.then(task).then(
    () => undefined,
    (err) => {
      console.error("[tauriStorage] write failed", err);
    },
  );
}

const tauriBackedStorage: StateStorage = {
  getItem(name) {
    return cache.has(name) ? cache.get(name)! : null;
  },
  setItem(name, value) {
    cache.set(name, value);
    if (store) {
      enqueueWrite(() => store!.set(name, value));
    }
  },
  removeItem(name) {
    cache.delete(name);
    if (store) {
      enqueueWrite(() => store!.delete(name));
    }
  },
};

const memoryStorage = new Map<string, string>();
const testSafeStorage: StateStorage = {
  getItem(name) {
    return memoryStorage.get(name) ?? null;
  },
  setItem(name, value) {
    memoryStorage.set(name, value);
  },
  removeItem(name) {
    memoryStorage.delete(name);
  },
};

function browserStorage(): StateStorage {
  return typeof localStorage === "undefined"
    ? testSafeStorage
    : (localStorage as unknown as StateStorage);
}

/** zustand 的 createJSONStorage 接收这个对象作为底层存储。 */
export const tauriStorage: StateStorage = isTauri()
  ? tauriBackedStorage
  : browserStorage();
