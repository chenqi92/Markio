import { expect, test, type Page } from "@playwright/test";
import { installMarkioE2E } from "./markio-fixture";

interface ZoneStats {
  uniqueBuckets: number;
  nonBackgroundRatio: number;
}

interface VisualStats {
  width: number;
  height: number;
  uniqueBuckets: number;
  zones: Record<string, ZoneStats>;
}

test.beforeEach(async ({ page }) => {
  await installMarkioE2E(page);
});

async function screenshotStats(page: Page, png: Buffer): Promise<VisualStats> {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const zoneStats = (x0: number, y0: number, w: number, h: number) => {
      const buckets = new Set<string>();
      let nonBackground = 0;
      let total = 0;
      const x1 = Math.min(canvas.width, x0 + w);
      const y1 = Math.min(canvas.height, y0 + h);
      for (let y = y0; y < y1; y += 4) {
        for (let x = x0; x < x1; x += 4) {
          const i = (y * canvas.width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          buckets.add(`${r >> 4}-${g >> 4}-${b >> 4}`);
          const nearWhite = r > 245 && g > 245 && b > 245;
          const nearPane = r > 226 && r < 247 && g > 226 && g < 247 && b > 226 && b < 247;
          if (!nearWhite && !nearPane) nonBackground += 1;
          total += 1;
        }
      }
      return {
        uniqueBuckets: buckets.size,
        nonBackgroundRatio: total === 0 ? 0 : nonBackground / total,
      };
    };

    const zones = {
      app: zoneStats(0, 0, canvas.width, canvas.height),
      sidebar: zoneStats(0, 70, 270, canvas.height - 120),
      editor: zoneStats(310, 140, 420, 520),
      preview: zoneStats(760, 140, 420, 520),
      toolbar: zoneStats(280, 38, canvas.width - 300, 52),
    };
    return {
      width: canvas.width,
      height: canvas.height,
      uniqueBuckets: zones.app.uniqueBuckets,
      zones,
    };
  }, png.toString("base64"));
}

test("primary split layout remains visually populated", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开文件夹…" }).click();
  await page.getByRole("treeitem", { name: /Daily\.md/ }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".preview")).toContainText("Daily");

  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
      .toast-host, .toast { display: none !important; }
    `,
  });

  const png = await page.screenshot({ fullPage: false, scale: "css" });
  const stats = await screenshotStats(page, png);

  expect(stats.width).toBe(1280);
  expect(stats.height).toBe(800);
  expect(stats.uniqueBuckets).toBeGreaterThan(40);
  expect(stats.zones.sidebar.uniqueBuckets).toBeGreaterThan(10);
  expect(stats.zones.editor.uniqueBuckets).toBeGreaterThan(10);
  expect(stats.zones.preview.uniqueBuckets).toBeGreaterThan(8);
  expect(stats.zones.toolbar.nonBackgroundRatio).toBeGreaterThan(0.005);
  expect(stats.zones.app.nonBackgroundRatio).toBeGreaterThan(0.03);
});
