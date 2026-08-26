import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.SCADA_E2E_BASE_URL;

async function signIn(page: Page) {
  if (!baseUrl) throw new Error("SCADA_E2E_BASE_URL is required for the SCADA e2e suite.");
  const username = process.env.SCADA_E2E_USERNAME;
  const password = process.env.SCADA_E2E_PASSWORD;
  if (!username || !password) throw new Error("global-setup.ts must run before this spec (missing SCADA_E2E_USERNAME/PASSWORD).");
  await page.goto(baseUrl);
  await page.addStyleTag({ content: "#replit-dev-banner { display: none !important; }" });
  await expect(page.getByRole("heading", { name: "Sign in to SCADA" })).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in to SCADA" }).click();
}

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
  // KPI/device destination), distinct from the full detail table below.
  const rawSection = page.getByTestId("section-raw");
  await expect(rawSection).toBeVisible();
  await expect(rawSection.locator("[data-testid^='raw-card-']")).toHaveCount(12);
  await expect(rawSection).toContainText("phaseAVoltageFixture");
  await expect(rawSection).toContainText("233.1");

  await expect(page.getByTestId("section-detail-table")).toBeVisible();
  await expect(page.getByTestId("section-detail-table")).toContainText("24 records");

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
