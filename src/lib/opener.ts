// 用 Tauri opener plugin 打开外链 / 文件，落到系统默认 app（浏览器、
// 资源管理器、邮件…）。在非 Tauri 环境下回退到 window.open。
//
// 用法：
//   await openExternal("https://example.com");

let cachedOpener: typeof import("@tauri-apps/plugin-opener") | null = null;
let triedOpener = false;

async function getOpener() {
  if (cachedOpener || triedOpener) return cachedOpener;
  triedOpener = true;
  try {
    cachedOpener = await import("@tauri-apps/plugin-opener");
  } catch {
    cachedOpener = null;
  }
  return cachedOpener;
}

export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  const o = await getOpener();
  if (o) {
    try {
      await o.openUrl(url);
      return;
    } catch {
      // fallback
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
