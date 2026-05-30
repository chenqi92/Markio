// 用 Tauri opener plugin 打开外链 / 文件，落到系统默认 app（浏览器、
// 资源管理器、邮件…）。在非 Tauri 环境下回退到 window.open。
//
// 用法：
//   await openExternal("https://example.com");
//
// 放行 http(s) 与 mailto / tel（交给系统邮件 / 电话处理器）。其他协议
//（javascript:、file:、自定义 scheme 等）拒绝，防止 markdown / AI 输出里的
// 恶意链接绕过浏览器同源限制或本地协议处理器。

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

export function isSafeExternalUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" ||
      u.protocol === "http:" ||
      u.protocol === "mailto:" ||
      u.protocol === "tel:"
    );
  } catch {
    return false;
  }
}

export async function openExternal(url: string): Promise<void> {
  if (!isSafeExternalUrl(url)) {
    if (typeof console !== "undefined") {
      console.warn("[opener] blocked non-http(s) URL:", url);
    }
    return;
  }
  const fallbackWindow =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)
      ? window.open("about:blank", "_blank", "noopener,noreferrer")
      : null;
  const o = await getOpener();
  if (o) {
    try {
      await o.openUrl(url);
      fallbackWindow?.close();
      return;
    } catch {
      // fallback
    }
  }
  if (fallbackWindow) {
    fallbackWindow.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
