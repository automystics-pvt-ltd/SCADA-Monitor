import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformTelemetryMapping } from "@workspace/db";
import { discoverDeviceParametersFromRawPayload } from "../lib/device-parameter-discovery.ts";
import {
  canWriteScheduledSnapshot,
  canonicalizeCapturedSnapshotParameter,
  canonicalSavedSnapshotParameters,
  isPersistenceWindowOpen,
  pageSavedParameterHistory,
  parameterFromPayload,
  persistenceSchedule,
  scadaTelemetryMappingResponse,
  snapshotParameterKey,
  snapshotEvidence,
  type StoredMessage,
} from "./mqtt.ts";

test("stamps the raw capture-path parameter with the same site-qualified identity discovery computes, so one physical register never saves as two records", () => {
  const rawPayload = JSON.stringify({
    name: "actpow",
    data: -11_309.54752,
    raw_data: "raw-register-evidence",
    full_addr: "305031",
    server_name: "ana",
  });
  const receivedAt = "2026-08-26T05:00:00.000Z";
  const captureSiteName = "Sunrise Solar Plant";
  const topic = "ana/telemetry";

  const parameter = parameterFromPayload(rawPayload);
  assert.ok(parameter);
  // TRN246 calibration stamps its own bookkeeping identity here, unrelated to
  // (and never collapsible with) the site-qualified format discovery uses.
  assert.equal(parameter!.source_identity, "trn246|ana|actpow|305031");

  const discoveredParameters = discoverDeviceParametersFromRawPayload(rawPayload, {
    siteName: captureSiteName,
    topic,
    receivedAt,
    provenance: "live",
  });
  assert.equal(discoveredParameters.length, 1);
  const discovered = discoveredParameters[0]!;
  assert.equal(discovered.sourceIdentity, "Sunrise Solar Plant|ana|actpow|305031");

  const message: StoredMessage = {
    topic,
    payload: rawPayload,
    parameter,
    discoveredParameters,
    receivedAt,
    sequence: 1,
    delivery: "immediate",
    captureSiteName,
  };

  const canonicalRaw = canonicalizeCapturedSnapshotParameter(parameter!, message);
  // This is the exact defect this test guards against: without capture-time
  // identity unification, the raw and discovered representations of one
  // physical register carry different sourceIdentity values and never merge.
  assert.equal(canonicalRaw.source_identity, discovered.sourceIdentity);

  const evidence = canonicalSavedSnapshotParameters({
    latestParameters: { [snapshotParameterKey(canonicalRaw)]: canonicalRaw },
    latestDiscoveredParameters: { [discovered.signalKey]: discovered },
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.sourceIdentity, discovered.sourceIdentity);
});

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

test("retains raw-only parameters alongside discovered parameters with explicit value and validation provenance", () => {
  const parameters = canonicalSavedSnapshotParameters({
    latestParameters: [
      {
        name: "Vendor mode",
        data: "enabled",
        raw_data: "0x01",
        site_name: "Plant A",
        server_name: "PLC A",
        full_addr: "40100",
        source_identity: "Plant A|PLC A|vendormode|40100",
        date_iso_8601: "2026-08-25T04:00:00.000Z",
      },
      {
        name: "Duplicate current",
        data: "11",
        raw_data: "0011",
        site_name: "Plant A",
        server_name: "PLC A",
        full_addr: "40101",
        source_identity: "Plant A|PLC A|duplicatecurrent|40101",
        date_iso_8601: "2026-08-25T04:00:00.000Z",
      },
    ],
    latestDiscoveredParameters: [
      {
        originalName: "Duplicate current",
        normalizedName: "duplicatecurrent",
        displayLabel: "DC current",
        rawValue: "0012",
        reportedValue: "12",
        sourceUnit: "A",
        siteName: "Plant A",
        sourceName: "PLC A",
        address: "40101",
        sourceIdentity: "Plant A|PLC A|duplicatecurrent|40101",
        observedAt: "2026-08-25T04:01:00.000Z",
        receivedAt: "2026-08-25T04:01:01.000Z",
        sourceMappingStatus: "source-reported",
        dataQuality: "source-reported",
        scalingStatus: "raw",
      },
    ],
  });

  assert.equal(parameters.length, 2);
  const rawOnly = parameters.find((parameter) => parameter.originalName === "Vendor mode");
  assert.deepEqual({
    originalValue: rawOnly?.originalValue,
    transportRawValue: rawOnly?.transportRawValue,
    normalizedValue: rawOnly?.normalizedValue,
    dataQuality: rawOnly?.dataQuality,
    validationStatus: rawOnly?.validationStatus,
  }, {
    originalValue: "enabled",
    transportRawValue: "0x01",
    normalizedValue: null,
    dataQuality: "raw",
    validationStatus: "raw",
  });
  const deduplicated = parameters.find((parameter) => parameter.originalName === "Duplicate current");
  assert.equal(deduplicated?.sourceReportedValue, "12");
  assert.equal(deduplicated?.transportRawValue, "0012");
  assert.equal(deduplicated?.observedAt, "2026-08-25T04:01:00.000Z");
});

test("pages saved-only history by stable source identity without dropping later snapshot evidence", () => {
  const snapshot = (id: number, endedAt: string, parameters: Record<string, unknown>[]) => ({
    id,
    topic: "trn246/modbus",
    windowStartedAt: new Date(new Date(endedAt).getTime() - 15 * 60_000),
    windowEndedAt: new Date(endedAt),
    capturedAt: new Date(endedAt),
    messageCount: parameters.length,
    parameterCount: parameters.length,
    data: { saveStatus: "saved", scheduledFor: endedAt, latestParameters: parameters },
  });
  const parameter = (value: string, observedAt: string) => ({
    name: "Validated DC voltage",
    data: value,
    raw_data: value,
    reported_value: value,
    source_unit: "V",
    scaling_status: "validated",
    site_name: "Plant A",
    server_name: "PLC A",
    full_addr: "40200",
    source_identity: "Plant A|PLC A|dcvoltage|40200",
    date_iso_8601: observedAt,
  });
  const history = pageSavedParameterHistory([
    snapshot(1, "2026-08-25T04:15:00.000Z", [parameter("600", "2026-08-25T04:14:00.000Z")]),
    snapshot(2, "2026-08-25T04:30:00.000Z", [parameter("610", "2026-08-25T04:29:00.000Z")]),
    snapshot(3, "2026-08-25T04:30:00.000Z", [{ ...parameter("700", "2026-08-25T04:29:00.000Z"), site_name: "Plant B", source_identity: "Plant B|PLC A|dcvoltage|40200" }]),
  ], { siteName: "Plant A", page: 1, pageSize: 1 });

  assert.equal(history.total, 2);
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0]?.normalizedValue, 610);
  assert.equal(history.records[0]?.provenance, "saved-snapshot");
});

test("keeps same-name raw registers with different full addresses separate until the scheduled save", () => {
  const first = snapshotParameterKey({
    name: "Vendor register",
    server_name: "PLC A",
    full_addr: "41001",
    site_name: "Plant A",
  });
  const second = snapshotParameterKey({
    name: "Vendor register",
    server_name: "PLC A",
    full_addr: "41002",
    site_name: "Plant A",
  });
  assert.notEqual(first, second);
});

test("retains saved history pages beyond the first 256 scheduled snapshots", () => {
  const base = Date.parse("2026-08-01T06:00:00.000Z");
  const snapshots = Array.from({ length: 300 }, (_, index) => {
    const endedAt = new Date(base + index * 15 * 60_000).toISOString();
    return {
      id: index + 1,
      topic: "trn246/modbus",
      windowStartedAt: new Date(new Date(endedAt).getTime() - 15 * 60_000),
      windowEndedAt: new Date(endedAt),
      capturedAt: new Date(endedAt),
      messageCount: 1,
      parameterCount: 1,
      data: {
        saveStatus: "saved",
        scheduledFor: endedAt,
        latestParameters: [{
          name: "Archive counter",
          data: String(index),
          raw_data: String(index),
          site_name: "Plant A",
          server_name: "PLC A",
          full_addr: "42000",
          source_identity: "Plant A|PLC A|archivecounter|42000",
          date_iso_8601: endedAt,
        }],
      },
    };
  });
  const history = pageSavedParameterHistory(snapshots, { siteName: "Plant A", page: 3, pageSize: 120 });
  assert.equal(history.total, 300);
  assert.equal(history.records.length, 60);
  assert.equal(history.records.at(-1)?.originalValue, "0");
});