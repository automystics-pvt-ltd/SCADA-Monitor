import assert from "node:assert/strict";
import test from "node:test";
import { snapshotEvidence } from "./mqtt.ts";

test("normalizes schema-v4 discovered snapshot evidence for saved KPIs without losing raw provenance", () => {
  const observedAt = "2026-08-25T04:00:00.000Z";
  const discovered = [
    ["actpow", "195", "kW", "31393536383339343234"],
    ["dailyeneregykwh", "42", "kWh", "3432"],
    ["totalenergy", "30670", "MWh", "3330363730"],
    ["todayyield", "1.4", "kWh/kWp", "3134"],
  ].map(([originalName, reportedValue, sourceUnit, rawValue]) => ({
    observationId: `${originalName}-sample`,
    signalKey: originalName,
    siteName: "trn246/modbus",
    deviceId: "inv-01",
    deviceName: "Inverter 01",
    topic: "trn246/modbus",
    originalName,
    normalizedName: originalName,
    displayLabel: originalName,
    category: "Overview",
    rawValue,
    reportedValue,
    reportedNumericValue: Number(reportedValue),
    value: Number(reportedValue),
    unit: null,
    sourceUnit,
    address: "305031",
    sourceName: "ana",
    sourceIdentity: `trn246/modbus|ana|${originalName}|305031`,
    sourceMappingStatus: "source-reported",
    observedAt,
    receivedAt: observedAt,
    provenance: "live",
    dataQuality: "source-reported",
    scalingStatus: "raw",
  }));
  const evidence = snapshotEvidence({
    id: 1,
    topic: "trn246/modbus",
    windowStartedAt: new Date("2026-08-25T03:45:00.000Z"),
    windowEndedAt: new Date(observedAt),
    capturedAt: new Date(observedAt),
    messageCount: 4,
    parameterCount: 4,
    data: { latestParameters: [], latestDiscoveredParameters: discovered },
  });

  assert.deepEqual(evidence.metrics.activePower, {
    parameter: "actpow",
    value: 195,
    rawData: "31393536383339343234",
    address: "305031",
    sourceTimestamp: observedAt,
    sourceReportedValue: "195",
    sourceReportedUnit: "kW",
    transportRawValue: "31393536383339343234",
    sourceIdentity: "trn246/modbus|ana|actpow|305031",
  });
  assert.equal(evidence.metrics.dailyEnergy?.value, 42);
  assert.equal(evidence.metrics.totalEnergy?.value, 30670);
  assert.equal(evidence.metrics.specificYield?.value, 1.4);
  assert.equal(evidence.parameters[0]?.name, "actpow");
  assert.equal(evidence.parameters[0]?.raw_data, "31393536383339343234");
});