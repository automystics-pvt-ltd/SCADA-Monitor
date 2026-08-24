import assert from "node:assert/strict";
import test from "node:test";
import { calculateScadaAggregates, isNewerSavedKpiSnapshot, latestRawMetric, parseSavedKpiSnapshot, rawInverterSignals } from "./telemetry-kpis.ts";
import { calculateVerifiedScadaKpis, selectVerifiedCalculation } from "./verified-kpis.ts";

test("selects the newest named raw register and keeps replay provenance", () => {
  const metric = latestRawMetric([
    { name: "actpow", data: "100", full_addr: "305031", timestamp: 100, provenance: "replay" },
    { name: "actpow", data: "200", full_addr: "305031", timestamp: 200, provenance: "live" },
  ], ["actpow"]);

  assert.deepEqual(metric, {
    parameter: "actpow",
    value: 200,
    address: "305031",
    provenance: "live",
  });
});

test("reports only numeric inverter register signals", () => {
  const signals = rawInverterSignals([
    { name: "inv2", data: "1041", addr: 2, provenance: "replay" },
    { name: "inv1", data: "1041", addr: 1, provenance: "live" },
    { name: "inv3", data: "unknown", addr: 3, provenance: "live" },
  ]);

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.parameter), ["inv1", "inv2"]);
});

test("parses a saved snapshot and accepts a newer window without carrying missing metrics", () => {
  const snapshot = parseSavedKpiSnapshot({
    id: 9,
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-24T03:45:00.000Z",
    windowEndedAt: "2026-08-24T04:00:00.000Z",
    scheduledFor: "2026-08-24T04:00:00.000Z",
    capturedAt: "2026-08-24T04:00:02.000Z",
    saveStatus: "incomplete",
    messageCount: 8,
    parameterCount: 2,
    metrics: {
      activePower: { parameter: "actpow", value: 44, rawData: "44", address: "305031" },
      dailyEnergy: null,
      totalEnergy: null,
      specificYield: null,
    },
  });

  assert.ok(snapshot);
  assert.equal(snapshot.metrics.dailyEnergy, null);
  assert.equal(isNewerSavedKpiSnapshot(snapshot, null), true);
  const newerSnapshot = { ...snapshot, id: 10, scheduledFor: "2026-08-24T04:15:00.000Z", capturedAt: "2026-08-24T04:15:02.000Z" };
  assert.equal(isNewerSavedKpiSnapshot(newerSnapshot, snapshot), true);
  assert.equal(isNewerSavedKpiSnapshot(snapshot, newerSnapshot), false);
});

test("sums inverter power tags while rejecting an isolated communication outlier", () => {
  const totals = calculateScadaAggregates([
    { name: "inv1", data: "3300", full_addr: "305003", timestamp: 50, provenance: "replay" },
    { name: "inv1", data: "3450", full_addr: "305003", timestamp: 100, provenance: "live" },
    { name: "inv2", data: "3445", full_addr: "305003", timestamp: 100, provenance: "live" },
    { name: "inv3", data: "3460", full_addr: "305003", timestamp: 100, provenance: "live" },
    { name: "inv4", data: "999999", full_addr: "305003", timestamp: 100, provenance: "live" },
  ]);

  assert.equal(totals.acPower.method, "inverter-sum");
  assert.equal(totals.acPower.value, 10355);
  assert.equal(totals.acPower.included.length, 3);
  assert.equal(totals.acPower.excluded.length, 1);
  assert.equal(totals.acPower.excluded[0]?.parameter, "inv4");
});

test("uses main meter and totalizing meter fallbacks without inventing an energy integral", () => {
  const totals = calculateScadaAggregates([
    { name: "actpow", data: "43000", full_addr: "305031", timestamp: 100, provenance: "live" },
    { name: "totalenergy", data: "1220000", full_addr: "305008", timestamp: 100, provenance: "live" },
  ]);

  assert.equal(totals.acPower.method, "main-meter");
  assert.equal(totals.acPower.value, 43000);
  assert.equal(totals.totalEnergy.method, "totalizing-meter");
  assert.equal(totals.totalEnergy.value, 1220000);
});

test("uses the three-phase formula only when all inputs explicitly validate scaling", () => {
  const totals = calculateScadaAggregates([
    { name: "phaseABvoltage", data: "400", full_addr: "305019", timestamp: 100, scaling_validated: true },
    { name: "Acurrent", data: "10", full_addr: "305022", timestamp: 100, scaling_validated: true },
    { name: "pf", data: "0.9", full_addr: "305035", timestamp: 100, scaling_validated: true },
  ]);

  assert.equal(totals.acPower.method, "three-phase");
  assert.equal(Math.round(totals.acPower.value ?? 0), 6235);
  assert.equal(totals.acPower.unit, "W");
});

test("does not label unapproved raw registers as engineering KPIs", () => {
  const kpis = calculateVerifiedScadaKpis([
    { name: "actpow", data: "43000", full_addr: "305031", timestamp: 100 },
    { name: "dailyeneregykwh", data: "44", full_addr: "305032", timestamp: 100 },
    { name: "totalenergy", data: "1220000", full_addr: "305008", timestamp: 100 },
  ]);

  assert.equal(kpis.acPower.quality, "awaiting-validation");
  assert.equal(kpis.dailyEnergy.value, null);
  assert.equal(kpis.totalEnergy.unit, null);
});

test("calculates verified power, counters, and specific yield with traceable inputs", () => {
  const kpis = calculateVerifiedScadaKpis([
    { name: "actpow", data: "43000", full_addr: "305031", timestamp: 100, scaling_validated: true, unit: "W", semantic: "active_power" },
    { name: "dailyeneregykwh", data: "180", full_addr: "305032", timestamp: 101, scaling_validated: true, unit: "kWh", semantic: "daily_energy" },
    { name: "totalenergy", data: "1220000", full_addr: "305008", timestamp: 102, scaling_validated: true, unit: "kWh", semantic: "cumulative_energy" },
    { name: "installedcapacitykwp", data: "50", full_addr: "profile", timestamp: 103, scaling_validated: true, unit: "kWp", semantic: "installed_capacity" },
  ]);

  assert.equal(kpis.acPower.value, 43);
  assert.equal(kpis.acPower.unit, "kW");
  assert.equal(kpis.acPower.method, "main-meter");
  assert.equal(kpis.dailyEnergy.value, 180);
  assert.equal(kpis.totalEnergy.value, 1220000);
  assert.equal(kpis.specificYield.value, 3.6);
  assert.equal(kpis.specificYield.unit, "kWh/kWp");
  assert.equal(kpis.specificYield.inputs.length, 2);
});

test("sums approved inverter readings and excludes an extreme outlier", () => {
  const rows = [3.3, 3.45, 3.46, 999]
    .map((value, index) => ({ name: `inv${index + 1}`, data: value, full_addr: `30500${index + 1}`, timestamp: 100, scaling_validated: true, unit: "kW", semantic: "active_power" }));
  const kpis = calculateVerifiedScadaKpis(rows);

  assert.equal(kpis.acPower.method, "inverter-sum");
  assert.equal(kpis.acPower.value, 10.21);
  assert.equal(kpis.acPower.excluded.length, 1);
  assert.equal(kpis.acPower.excluded[0]?.parameter, "inv4");
});

test("keeps snapshot provenance and never replaces a live verified calculation", () => {
  const snapshot = calculateVerifiedScadaKpis([
    { name: "actpow", data: 1000, full_addr: "305031", timestamp: 100, scaling_validated: true, unit: "W", semantic: "active_power" },
  ], {
    snapshotWindow: {
      startedAt: "2026-08-24T04:00:00.000Z",
      endedAt: "2026-08-24T04:15:00.000Z",
      scheduledFor: "2026-08-24T04:15:00.000Z",
    },
  });
  const live = calculateVerifiedScadaKpis([
    { name: "actpow", data: 2000, full_addr: "305031", timestamp: 200, scaling_validated: true, unit: "W", semantic: "active_power" },
  ]);

  assert.equal(snapshot.acPower.provenance, "snapshot");
  assert.equal(snapshot.acPower.snapshotWindow?.scheduledFor, "2026-08-24T04:15:00.000Z");
  assert.equal(selectVerifiedCalculation(live.acPower, snapshot.acPower).value, 2);
});

test("requires an explicit semantic mapping and rejects stale live evidence", () => {
  const unlabelled = calculateVerifiedScadaKpis([
    { name: "actpow", data: 43000, full_addr: "305031", timestamp: 100, scaling_validated: true, unit: "W" },
  ]);
  const stale = calculateVerifiedScadaKpis([
    { name: "actpow", data: 43000, full_addr: "305031", timestamp: 100, scaling_validated: true, unit: "W", semantic: "active_power" },
  ], { asOf: 1_000_000, maximumAgeMs: 100 });

  assert.equal(unlabelled.acPower.quality, "awaiting-validation");
  assert.equal(stale.acPower.quality, "awaiting-validation");
});