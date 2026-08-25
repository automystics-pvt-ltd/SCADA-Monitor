import { expect, test, type Page } from "@playwright/test";

import { VISUAL_TEST_PASSWORD, VISUAL_TEST_USERNAME } from "./global-setup.ts";

const viewports = [720, 1024, 1280, 1536] as const;
const themes = ["dark", "light"] as const;
const dashboardUrl = process.env.SCADA_VISUAL_BASE_URL;

async function signInToDashboard(page: Page) {
  if (!dashboardUrl) throw new Error("SCADA_VISUAL_BASE_URL is required for the visual dashboard test.");
  await page.clock.install({ time: new Date("2099-01-01T00:00:15.000Z") });
  await page.goto(dashboardUrl);
  await page.addStyleTag({ content: "#replit-dev-banner { display: none !important; }" });
  await expect(page.getByRole("heading", { name: "Sign in to SCADA" })).toBeVisible();
  await page.getByLabel("Username").fill(VISUAL_TEST_USERNAME);
  await page.getByLabel("Password").fill(VISUAL_TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in to SCADA" }).click();
  await expect(page.getByTestId("status-dashboard-data-source")).toContainText("Saved", { timeout: 20_000 });
  await expect(page.getByTestId("panel-saved-backend-record")).toBeVisible();
}

async function assertReadableSurface(page: Page, testId: string, viewportWidth: number) {
  const surface = page.getByTestId(testId);
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box, `${testId} should render a measurable surface`).not.toBeNull();
  expect(box!.x, `${testId} should not start beyond the left content edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${testId} should not overflow the document width`).toBeLessThanOrEqual(viewportWidth + 1);
  expect(box!.width, `${testId} should retain readable width`).toBeGreaterThan(180);
}

for (const theme of themes) {
  for (const width of viewports) {
    test(`authenticated ${theme} dashboard at ${width}px has no page overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1200 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await signInToDashboard(page);
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });
      const themeToggle = page.getByRole("button", { name: "Switch to light mode" });
      if (theme === "light") {
        await themeToggle.click();
        await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
      } else {
        await expect(themeToggle).toBeVisible();
      }

      await expect(page.getByTestId("dashboard-kpis")).toBeVisible();
      await expect(page.getByTestId("kpi-total-ac-power")).toBeVisible();
      await expect(page.getByTestId("kpi-active-alarms")).toBeVisible();
      await expect(page.getByTestId("dashboard-power-flow")).toBeVisible();
      await expect(page.getByTestId("inverter-fleet-tiles")).toHaveCount(1);
      await expect(page.getByTestId("inverter-fleet-tiles").getByRole("button")).toHaveCount(5);
      await expect(page.getByTestId("panel-alarm-summary")).toContainText("Alarm evidence");
      await expect(page.getByTestId("panel-data-quality")).toContainText("Data Quality");

      for (const testId of [
        "status-dashboard-data-source",
        "dashboard-kpis",
        "dashboard-power-flow",
        "inverter-fleet-tiles",
        "panel-alarms-data-quality",
        "panel-saved-backend-record",
      ]) {
        await assertReadableSurface(page, testId, width);
      }

      const documentWidth = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(
        documentWidth.scrollWidth,
        `document-level horizontal overflow at ${width}px (${documentWidth.scrollWidth}px > ${documentWidth.clientWidth}px)`,
      ).toBeLessThanOrEqual(documentWidth.clientWidth + 1);

      await expect(page).toHaveScreenshot(`dashboard-${theme}-${width}.png`, {
        fullPage: true,
        animations: "disabled",
      });
    });
  }
}