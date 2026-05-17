/**
 * 内存 LRU 缓存 AI 流式响应的最终结果。
 *
 * - key = sha256(provider \0 model \0 system \0 JSON(messages))
 * - 容量 50 条；超出按 FIFO 淘汰（Map 维持插入顺序）
 * - 不持久化：重启即清；避免跨会话还回放旧答案让用户困惑
 * - 仅在 settings.aiCacheEnabled = true 时使用；否则 lookup 永远返回 null
 *
 * 设计上仅缓存"完全相同"的输入；用户改一个字都会重发请求。
 */

const MAX_ENTRIES = 50;

export interface AICacheValue {
  text: string;
  refs: unknown[] | null;
}

const cache = new Map<string, AICacheValue>();

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function makeKey(
  provider: string,
  model: string,
  system: string | undefined,
  messages: unknown[],
): Promise<string> {
  return sha256Hex(
    `${provider}\0${model}\0${system ?? ""}\0${JSON.stringify(messages)}`,
  );
}

export function lookup(key: string): AICacheValue | null {
  return cache.get(key) ?? null;
}

export function remember(key: string, value: AICacheValue) {
  // 如果已存在先删，重新插到末尾（保持 LRU 行为）
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

export function clear() {
  cache.clear();
}

export function size(): number {
  return cache.size;
}
