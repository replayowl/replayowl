import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  reporter: [["list"]],
  use: { browserName: "chromium", channel: "chromium", viewport: { width: 1280, height: 800 } },
});
