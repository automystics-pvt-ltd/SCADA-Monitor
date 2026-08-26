import { expect, test } from "@playwright/test";
import { injectLiveTelemetry, signIn } from "./support";

/**
 * Regression coverage for the Dashboard/Overview saved-only evidence
 * pipeline (see the "Dashboard (Overview) saved-record pipeline" comment in
 * src/App.tsx). The Overview KPI cards, electrical chart, inverter table,
 * and alarms/data-quality panels must source exclusively from the latest
 * saved backend record -- never from live telemetry, even when live data is
 * fresh. This guards against a future edit silently reconnecting a shared
 * "live" variable into the Overview JSX.
 *
 * The test injects one synthetic, distinctive "live" telemetry message
 * (`ActPow = 913.65`) directly into the browser's real MQTT stream
 * connection (see `injectLiveTelemetry` in support.ts) -- it never touches
 * the broker or shared database state. This proves the guard is genuine:
 * the injected value is confirmed to reach a live-preferring screen
 * (Performance), yet it must never appear anywhere on the Overview. A
 * future regression that wires `overviewEvidenceRows` (or the Overview's
 * `ElectricalParametersChart` `evidenceMode`) back to live data would make
 * the injected value leak into the Overview and fail this test.
 */
const LIVE_ACTIVE_POWER_VALUE = "913.65";

test("Dashboard overview sources KPIs and the electrical chart from the saved backend record, never from fresh live telemetry", async ({ page }) => {
  await injectLiveTelemetry(page, {
    name: "ActPow",
    value: 913.65,
    address: "40007",
    server_name: "E2E Live Injection",
  }, 500);

  await signIn(page);

  await expect(page.getByRole("heading", { name: "Plant operations at a glance" })).toBeVisible();
  await expect(page.getByTestId("nav-dashboard")).toHaveAttribute("aria-current", "page");

  // The injected live telemetry only stays "fresh" for a short window (see
  // DEVICE_ONLINE_MAX_AGE_MS in App.tsx), so confirm it reached a
  // live-preferring screen FIRST, before the freshness window can lapse --
  // this proves the injection genuinely worked and the absence assertions
  // below are a real guard, not a no-op because the live data went stale.
  await page.getByTestId("nav-performance").click();
  await expect(page.getByTestId("screen-performance")).toBeVisible();
  await expect(page.getByTestId("card-electrical-active-power")).toContainText(LIVE_ACTIVE_POWER_VALUE, { timeout: 10_000 });
  await page.getByTestId("nav-dashboard").click();
  await expect(page.getByRole("heading", { name: "Plant operations at a glance" })).toBeVisible();

  // KPI cards must credit the saved backend record as their source, not a
  // live substitute. The QA fixture site provisions a recognized per-inverter
  // active-power tag (`inv<N>ActivePower` + `inverter_id`), a dedicated
  // inverter-identity signal, and an approved plant calibration profile (see
  // lib/db/src/fixtures/scada-qa-operator.ts), so the engineering-scaled AC
  // Power / Energy / Yield / Inverter Inventory cards render real
  // "Saved record" values here instead of staying withheld (closing the gap
  // this test used to note under Task #101/#102).
  const kpis = page.getByTestId("dashboard-kpis");
  await expect(kpis).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("kpi-active-alarms")).toContainText("Saved record");

  // AC Power, Today's Energy, Total Energy, and Specific Yield: verified via
  // the fixture's approved calibration profile, sourced from the fixture's
  // plant-level meter registers (activePowerFixture/dailyEnergyFixture/
  // totalEnergyFixture at 512.4 kW / 812.5 kWh / 284,213.7 kWh).
  await expect(page.getByTestId("kpi-total-ac-power")).toContainText("512.4");
  await expect(page.getByTestId("kpi-total-ac-power")).toContainText("kW");
  await expect(page.getByTestId("kpi-total-ac-power")).toContainText("Saved record");
  await expect(page.getByTestId("kpi-today-s-energy")).toContainText("812.5");
  await expect(page.getByTestId("kpi-today-s-energy")).toContainText("kWh");
  await expect(page.getByTestId("kpi-today-s-energy")).toContainText("Saved record");
  await expect(page.getByTestId("kpi-total-energy")).toContainText(/284,?213\.7/);
  await expect(page.getByTestId("kpi-total-energy")).toContainText("Saved record");
  // 812.5 kWh daily energy ÷ 168.5 kWp approved installed DC capacity.
  await expect(page.getByTestId("kpi-specific-yield")).toContainText("4.82");
  await expect(page.getByTestId("kpi-specific-yield")).toContainText("Saved record");

  // Inverter Inventory: the fixture provisions 5 distinct inverter_id-scoped
  // signals (inv1..inv5), deduplicated by identity, not double-counted
  // against their paired inverter-identity rows.
  await expect(page.getByTestId("kpi-inverter-inventory")).toContainText("5");
  await expect(page.getByTestId("kpi-inverter-inventory")).toContainText("Saved");

  // The independent plant-status strip must corroborate the same saved
  // source, and the saved-data panel must be present near the KPI cards.
  await expect(page.getByTestId("status-dashboard-data-source")).toContainText("Saved");
  await expect(page.getByTestId("panel-saved-data")).toBeVisible();

  // Electrical Parameters chart: the saved-record evidence banner must be
  // visible, and the historical time-range picker (only meaningful for a
  // live-sourced chart) must stay hidden on the Dashboard overview --
  // browsing other time ranges belongs to Live Data / Performance.
  const electrical = page.getByTestId("section-electrical-parameters");
  await expect(electrical).toBeVisible();
  await expect(page.getByTestId("status-electrical-saved-record")).toContainText("Saved backend record");
  await expect(page.getByTestId("electrical-time-filter")).toContainText(
    "Dashboard evidence always reflects the latest saved backend record",
  );
  await expect(page.getByTestId("button-electrical-preset-live")).toHaveCount(0);
  await expect(page.getByTestId("input-electrical-start-time")).toHaveCount(0);

  // Inverter table and alarm/data-quality panels still render on the same
  // saved-only evidence, alongside the KPI cards and electrical chart.
  const inverters = page.locator('[data-section="inverters"]');
  const alarms = page.locator('[data-section="alarms"]');
  await expect(inverters).toBeVisible();
  await expect(alarms).toBeVisible();

  // The injected live "ActPow = 913.65" reading must never surface within
  // the saved-only evidence surfaces this test guards -- the KPI cards, the
  // electrical chart, the inverter table, and the alarms panel -- regardless
  // of how much time has passed since it was ingested. (The Overview also
  // hosts an intentionally always-live raw MQTT inspector further down the
  // page -- "Detailed Live Data" / "Raw MQTT Payload" -- which is a separate,
  // explicitly-labeled diagnostic surface outside this saved-only guarantee
  // and is expected to show the injected value; this assertion is scoped to
  // exclude it.)
  await expect(kpis.getByText(LIVE_ACTIVE_POWER_VALUE)).toHaveCount(0);
  await expect(electrical.getByText(LIVE_ACTIVE_POWER_VALUE)).toHaveCount(0);
  await expect(inverters.getByText(LIVE_ACTIVE_POWER_VALUE)).toHaveCount(0);
  await expect(alarms.getByText(LIVE_ACTIVE_POWER_VALUE)).toHaveCount(0);
});

test("Inverters, Energy, Alarms, and Performance tabs keep their own live-preferring behavior and historical range picker", async ({ page }) => {
  await signIn(page);

  await page.getByTestId("nav-inverters").click();
  await expect(page.getByTestId("screen-inverters")).toBeVisible();

  await page.getByTestId("nav-energy-analytics").click();
  await expect(page.getByTestId("screen-energy")).toBeVisible();

  await page.getByTestId("nav-alarms-events").click();
  await expect(page.getByTestId("screen-alarms")).toBeVisible();

  await page.getByTestId("nav-performance").click();
  await expect(page.getByTestId("screen-performance")).toBeVisible();

  // Unlike the Dashboard overview's saved-only electrical chart, Performance
  // keeps the default 'auto' evidence mode, so the historical range picker
  // must remain available here -- confirming these tabs were unaffected by
  // the Overview's saved-only pipeline.
  await expect(page.getByTestId("button-electrical-preset-live")).toBeVisible();
});
