import assert from "node:assert/strict";
import test from "node:test";
import { isNewerSavedKpiSnapshot, latestRawMetric, parseSavedKpiSnapshot, rawInverterSignals } from "./telemetry-kpis.ts";

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