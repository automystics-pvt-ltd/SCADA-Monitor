import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support";

async function assertAnalyticsSections(page: Page) {
  const analytics = page.getByTestId("saved-parameter-analytics");
  await expect(analytics).toBeVisible({ timeout: 20_000 });

  // The QA fixture site's saved evidence is synthetic but deliberately
  // includes `validated` records, unlike this project's real plant data
  // (see replit.md Gotchas) -- so every category should render here.
  await expect(page.getByTestId("section-kpi")).toBeVisible();
  await expect(page.getByTestId("section-kpi").locator("[data-testid^='kpi-card-']")).toHaveCount(4);

  await expect(page.getByTestId("section-summary")).toBeVisible();
  await expect(page.getByTestId("section-summary").locator("[data-testid^='summary-card-']")).toHaveCount(3);

  await expect(page.getByTestId("section-device")).toBeVisible();
  await expect(page.getByTestId("section-device").locator("[data-testid^='device-card-']")).toHaveCount(5);

  // Raw evidence & status: unvalidated fixture parameters (no admin-mapped
  // KPI/device destination), distinct from the full detail table below. This
  // includes the 12 original unvalidated phase/string/alarm/comms registers
  // plus the 5 dedicated inv1..inv5 inverter-identity signals (also
  // unvalidated -- they declare a physical inverter, not a scaled
  // engineering value, so they correctly land here rather than in "device").
  const rawSection = page.getByTestId("section-raw");
  await expect(rawSection).toBeVisible();
  await expect(rawSection.locator("[data-testid^='raw-card-']")).toHaveCount(17);
  await expect(rawSection).toContainText("phaseAVoltageFixture");
  await expect(rawSection).toContainText("233.1");
  await expect(rawSection).toContainText("inv1IdentityFixture");

  await expect(page.getByTestId("section-detail-table")).toBeVisible();
  await expect(page.getByTestId("section-detail-table")).toContainText("29 records");

  await expect(page.getByTestId("pagination-next")).toBeVisible();
  await expect(page.getByTestId("pagination-prev")).toBeDisabled();
  await page.getByTestId("pagination-next").click();
  await expect(page.getByTestId("pagination-prev")).toBeEnabled();
}

for (const screen of [
  { navTestId: "nav-energy-analytics", screenTestId: "screen-energy" },
  { navTestId: "nav-performance", screenTestId: "screen-performance" },
]) {
  test(`${screen.screenTestId} saved-parameter analytics render for the QA fixture site`, async ({ page }) => {
    await signIn(page);
    await page.getByTestId(screen.navTestId).click();
    await expect(page.getByTestId(screen.screenTestId)).toBeVisible();
    await assertAnalyticsSections(page);
  });
}
