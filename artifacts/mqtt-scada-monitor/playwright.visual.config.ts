import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SCADA_VISUAL_BASE_URL;

if (!baseURL) {
  throw new Error(
    "SCADA_VISUAL_BASE_URL is required (for example https://<repl-domain>/mqtt-scada-monitor/). "
    + "Run the API Server and MQTT SCADA Monitor workflows before starting the visual suite.",
  );
}

export default defineConfig({
  testDir: "./visual-regression",
  globalSetup: "./visual-regression/global-setup.ts",
  outputDir: path.join("/tmp", "mqtt-scada-monitor-dashboard-visual"),
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: path.join("/tmp", "mqtt-scada-monitor-dashboard-visual-report"), open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    colorScheme: "dark",
    launchOptions: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
    ...devices["Desktop Chrome"],
  },
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
    },
  },
});