import { expect, test } from "@playwright/test";
import { E2E_DAILY_PATH, installMarkioE2E } from "./markio-fixture";

test.beforeEach(async ({ page }) => {
  await installMarkioE2E(page);
});

test("opens a vault, edits with conflict recovery, and jumps from global search", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "markio" })).toBeVisible();
  await page.getByRole("button", { name: "打开文件夹…" }).click();

  await expect(page.getByRole("treeitem", { name: /Daily\.md/ })).toBeVisible();
  await page.getByRole("treeitem", { name: /Daily\.md/ }).click();
  await expect(page.locator(".cm-content")).toBeVisible();

  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("# Daily\n\nE2E edit marker\nsearch token\n");

  await page.evaluate(() => {
    const state = window.__MARKIO_E2E_STATE__;
    if (!state) throw new Error("E2E state missing");
    state.conflictNextSave = true;
  });
  await page.getByTitle(/保存/).click();
  await expect(page.getByText("覆盖磁盘版本？")).toBeVisible();
  await page.getByRole("button", { name: "覆盖保存" }).click();
  await expect(page.getByText("已强制覆盖")).toBeVisible();

  const saved = await page.evaluate(
    (path) => window.__MARKIO_E2E_STATE__?.readFile(path),
    E2E_DAILY_PATH,
  );
  expect(saved).toContain("E2E edit marker");

  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.getByPlaceholder(/搜索/).fill("search token");
  await expect(page.locator(".cmdk-item").filter({ hasText: "Daily.md" })).toBeVisible();
  await page.locator(".cmdk-item").filter({ hasText: "Daily.md" }).first().click();

  await expect(page.locator(".findbar input")).toHaveValue("search token");
  await expect(page.locator(".findbar .count")).toContainText("1 / 1");
});

test("split mode keeps source and preview scroll positions in sync", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开文件夹…" }).click();

  await page.evaluate(
    (path) => {
      const state = window.__MARKIO_E2E_STATE__;
      if (!state) throw new Error("E2E state missing");
      const sections = Array.from({ length: 90 }, (_, index) => {
        const n = index + 1;
        return `## Section ${n}\n\nparagraph ${n} ${"sync text ".repeat(24)}`;
      });
      state.mutateFile(path, `# Scroll Sync\n\n${sections.join("\n\n")}\n`);
    },
    E2E_DAILY_PATH,
  );

  await page.getByRole("treeitem", { name: /Daily\.md/ }).click();
  const source = page.locator(".cm-scroller");
  const preview = page.locator(".preview-pane");
  await expect(source).toBeVisible();
  await expect(preview.locator("[data-line]").first()).toBeVisible();
  await expect
    .poll(() => preview.locator("[data-line]").count())
    .toBeGreaterThan(40);

  await source.evaluate((el) => {
    el.scrollTop = 2400;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => preview.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);

  await page.waitForTimeout(250);
  const before = await source.evaluate((el) => el.scrollTop);
  await preview.evaluate((el) => {
    el.scrollTop = 3600;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () => {
      const current = await source.evaluate((el) => el.scrollTop);
      return Math.abs(current - before);
    })
    .toBeGreaterThan(200);
});
