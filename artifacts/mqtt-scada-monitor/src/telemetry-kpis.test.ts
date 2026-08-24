import assert from "node:assert/strict";
import test from "node:test";
import { calculateScadaAggregates, isNewerSavedKpiSnapshot, latestRawMetric, parseSavedKpiSnapshot, rawInverterSignals } from "./telemetry-kpis.ts";

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