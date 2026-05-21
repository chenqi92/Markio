// 按 provider 缓存 /models 拉取结果到 localStorage，24h TTL。
// 设置页每次打开都打网络会卡感知，所以默认走缓存；用户点🔄会强刷。

const PREFIX = "markio.aiModels.v1:";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedModel {
  id: string;
  label?: string;
  group?: string;
  contextLength?: number;
}

interface CacheEntry {
  ts: number;
  models: CachedModel[];
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getCached(provider: string): CachedModel[] | null {
  const ls = safeStorage();
  if (!ls) return null;
  const raw = ls.getItem(PREFIX + provider);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed || typeof parsed.ts !== "number" || !Array.isArray(parsed.models)) {
      return null;
    }
    if (Date.now() - parsed.ts > TTL_MS) return null;
    return parsed.models;
  } catch {
    return null;
  }
}

export function getCachedAt(provider: string): number | null {
  const ls = safeStorage();
  if (!ls) return null;
  const raw = ls.getItem(PREFIX + provider);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CacheEntry;
    return typeof parsed.ts === "number" ? parsed.ts : null;
  } catch {
    return null;
  }
}

export function setCached(provider: string, models: CachedModel[]) {
  const ls = safeStorage();
  if (!ls) return;
  try {
    const entry: CacheEntry = { ts: Date.now(), models };
    ls.setItem(PREFIX + provider, JSON.stringify(entry));
  } catch {
    // quota 满了就算了，下次重拉
  }
}

export function clearCached(provider: string) {
  const ls = safeStorage();
  if (!ls) return;
  ls.removeItem(PREFIX + provider);
}
