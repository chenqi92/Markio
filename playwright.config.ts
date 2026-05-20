import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 7_000,
  },
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "test-results/e2e",
  use: {
    baseURL: "http://127.0.0.1:18642",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:18642",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
