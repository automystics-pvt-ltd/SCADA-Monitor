import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SCADA_E2E_BASE_URL;

if (!baseURL) {
  throw new Error(
    "SCADA_E2E_BASE_URL is required (for example https://<repl-domain>/mqtt-scada-monitor/). "
    + "Run the API Server and MQTT SCADA Monitor workflows before starting the e2e suite.",
  );
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: path.join("/tmp", "mqtt-scada-monitor-e2e"),
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: path.join("/tmp", "mqtt-scada-monitor-e2e-report"), open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
    ...devices["Desktop Chrome"],
  },
});
