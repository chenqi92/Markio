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

/**
 * 写 PNG 图到剪贴板（仅 Tauri 桌面环境）。
 * navigator.clipboard 写图片在 Safari/Firefox 兼容性差，桌面端走 Tauri plugin。
 */
export async function writeImage(pngBytes: Uint8Array): Promise<void> {
  const t = await getTauri();
  if (!t) throw new Error("clipboard image only supported in desktop");
  await t.writeImage(pngBytes);
}

/**
 * 读剪贴板图片 → PNG bytes。返回 null 表示当前剪贴板没有图。
 *
 * Tauri readImage 返回的是 Rust 侧的 Image 资源，其 .rgba() 给的是原始
 * RGBA 像素流，需要带宽高才能解码。这里用 OffscreenCanvas 把 RGBA 重新
 * 编码为 PNG，调用方拿到的就是可直接展示/再写回剪贴板的 PNG 字节。
 */
export async function readImageAsPng(): Promise<Uint8Array | null> {
  const t = await getTauri();
  if (!t) return null;
  try {
    const img = await t.readImage();
    const [rgba, size] = await Promise.all([img.rgba(), img.size()]);
    return await rgbaToPng(rgba, size.width, size.height);
  } catch {
    return null;
  }
}

async function rgbaToPng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : (() => {
          const c = document.createElement("canvas");
          c.width = width;
          c.height = height;
          return c;
        })();
  const ctx = (canvas as HTMLCanvasElement).getContext("2d") as
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("canvas 2d context not available");
  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
  ctx.putImageData(imageData, 0, 0);
  const blob: Blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: "image/png" })
      : await new Promise<Blob>((resolve, reject) => {
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error("toBlob null"))),
            "image/png",
          );
        });
  return new Uint8Array(await blob.arrayBuffer());
}
