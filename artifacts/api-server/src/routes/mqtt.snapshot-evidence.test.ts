import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformTelemetryMapping } from "@workspace/db";
import {
  canWriteScheduledSnapshot,
  isPersistenceWindowOpen,
  persistenceSchedule,
  scadaTelemetryMappingResponse,
  snapshotEvidence,
} from "./mqtt.ts";

test("returns every approved transform field needed by the SCADA mapping overlay", () => {
  const mapping: PlatformTelemetryMapping = {
    id: "map-1",
    siteName: "Plant A",
    deviceId: "INV-01",
    sourceIdentity: "Plant A|Gateway A|vendorpower|40001",
    sourceName: "Gateway A",
    normalizedName: "vendorpower",
    address: "40001",
    destination: "active-power",
    displayLabel: "Inverter AC power",
    category: "Electrical",
    inverterIdentity: "inv1",
    sourceUnit: "kW",
    displayUnit: "W",
    scalingMultiplier: 1_000,
    scalingOffset: 5,
    scalingStatus: "approved",
    status: "active",
    version: 3,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    clearedAt: null,
    createdAt: new Date("2026-08-25T07:00:00.000Z"),
    updatedAt: new Date("2026-08-25T07:00:00.000Z"),
  };

  assert.deepEqual(scadaTelemetryMappingResponse(mapping), {
    id: "map-1",
    deviceId: "INV-01",
    sourceIdentity: "Plant A|Gateway A|vendorpower|40001",
    sourceName: "Gateway A",
    normalizedName: "vendorpower",
    address: "40001",
    destination: "active-power",
    displayLabel: "Inverter AC power",
    category: "Electrical",
    inverterIdentity: "inv1",
    sourceUnit: "kW",
    displayUnit: "W",
    scalingMultiplier: 1_000,
    scalingOffset: 5,
    scalingStatus: "approved",
    version: 3,
  });
});

test("pauses scheduled saves and retry processing outside the plant-local 06:00–18:00 window", () => {
  const beforeClose = persistenceSchedule(new Date("2026-08-25T12:29:59.000Z"));
  assert.equal(beforeClose.collecting, true);
  assert.equal(isPersistenceWindowOpen(new Date("2026-08-25T12:29:59.000Z")), true);

  const atClose = persistenceSchedule(new Date("2026-08-25T12:30:00.000Z"));
  assert.equal(atClose.collecting, false);
  assert.equal(atClose.nextScheduledAt.toISOString(), "2026-08-26T00:30:00.000Z");
  assert.equal(isPersistenceWindowOpen(new Date("2026-08-25T12:30:00.000Z")), false);

  const overnight = persistenceSchedule(new Date("2026-08-25T18:00:00.000Z"));
  assert.equal(overnight.collecting, false);
  assert.equal(overnight.nextScheduledAt.toISOString(), "2026-08-26T00:30:00.000Z");

  const beforeOpen = persistenceSchedule(new Date("2026-08-26T00:29:59.000Z"));
  assert.equal(beforeOpen.collecting, false);
  assert.equal(beforeOpen.nextScheduledAt.toISOString(), "2026-08-26T00:30:00.000Z");

  const atOpen = persistenceSchedule(new Date("2026-08-26T00:30:00.000Z"));
  assert.equal(atOpen.collecting, true);
  assert.equal(atOpen.nextScheduledAt.toISOString(), "2026-08-26T00:45:00.000Z");
  assert.equal(isPersistenceWindowOpen(new Date("2026-08-26T00:30:00.000Z")), true);
});

test("stops retry and reconciliation writes that cross 18:00 while allowing only the final boundary flush", () => {
  const scheduledDaytimeWindow = new Date("2026-08-25T12:15:00.000Z");
  const finalBoundary = new Date("2026-08-25T12:30:00.000Z");
  const retryAttemptTimes = [
    new Date("2026-08-25T12:29:59.000Z"),
    new Date("2026-08-25T12:30:00.000Z"),
  ];

  assert.deepEqual(
    retryAttemptTimes.map((attemptedAt) => canWriteScheduledSnapshot(attemptedAt, scheduledDaytimeWindow)),
    [true, false],
  );
  assert.deepEqual(
    retryAttemptTimes.map((attemptedAt) => canWriteScheduledSnapshot(attemptedAt, scheduledDaytimeWindow)),
    [true, false],
  );
  assert.equal(canWriteScheduledSnapshot(new Date("2026-08-25T12:30:01.000Z"), finalBoundary), false);
  assert.equal(canWriteScheduledSnapshot(new Date("2026-08-25T12:30:01.000Z"), finalBoundary, true), true);
  assert.equal(canWriteScheduledSnapshot(new Date("2026-08-25T12:31:00.000Z"), finalBoundary, true), false);
  assert.equal(canWriteScheduledSnapshot(new Date("2026-08-25T18:00:00.000Z"), finalBoundary, true), false);
});

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