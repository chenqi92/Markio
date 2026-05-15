// 统一剪贴板封装：优先 Tauri 原生 plugin（绕过 webview 焦点 / 权限问题），
// 失败时回退到 navigator.clipboard。在纯浏览器环境下（dev preview）只
// 走后者。
//
// 用法：
//   import { writeText, readText } from "@/lib/clipboard";
//   await writeText("hi");

let cachedTauri: typeof import("@tauri-apps/plugin-clipboard-manager") | null = null;
let triedTauri = false;

async function getTauri() {
  if (cachedTauri || triedTauri) return cachedTauri;
  triedTauri = true;
  try {
    cachedTauri = await import("@tauri-apps/plugin-clipboard-manager");
  } catch {
    cachedTauri = null;
  }
  return cachedTauri;
}

export async function writeText(text: string): Promise<void> {
  const t = await getTauri();
  if (t) {
    try {
      await t.writeText(text);
      return;
    } catch {
      // 落到 navigator fallback
    }
  }
  await navigator.clipboard.writeText(text);
}

export async function readText(): Promise<string> {
  const t = await getTauri();
  if (t) {
    try {
      return await t.readText();
    } catch {
      // 落到 navigator
    }
  }
  return navigator.clipboard.readText();
}
