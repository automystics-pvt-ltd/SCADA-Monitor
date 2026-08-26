import assert from "node:assert/strict";
import test from "node:test";
import { calculateScadaAggregates, isNewerSavedKpiSnapshot, latestRawCounterMetric, latestRawMetric, parseSavedKpiSnapshot, rawInverterIdentitySignals, rawInverterSignals, SAVED_KPI_SNAPSHOT_MAX_AGE_MS, selectDashboardSavedEvidence, selectSavedKpiEvidence } from "./telemetry-kpis.ts";
import { assessSourceBackedInverterFleet, assessValidatedLiveInverterFleet, assessValidatedSavedInverterFleet, calculateVerifiedScadaKpis, calibrationPreviewCalculation, selectVerifiedCalculation } from "./verified-kpis.ts";

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

test("prefers an explicit customer-reported value and its source unit over transport raw data", () => {
  const metric = latestRawMetric([{
    name: "actpow",
    data: "31393536383339343234",
    raw_data: "31393536383339343234",
    reported_value: "1956839424",
    reported_unit: "kW",
    full_addr: "305031",
    server_name: "ana",
    provenance: "live",
  }], ["actpow"]);

  assert.deepEqual(metric, {
    parameter: "actpow",
    value: 1956839424,
    address: "305031",
    provenance: "live",
    sourceUnit: "kW",
    sourceReported: true,
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

test("keeps the latest generic source tag when an explicit inverter identity is declared", () => {
  const signals = rawInverterSignals([
    { name: "ac_output", inverter_id: "INV-A", data: "2200", full_addr: "305003", server_name: "north-array", timestamp: 100, provenance: "live" },
    { name: "ac_output", inverter_id: "INV-A", data: "2350", full_addr: "305003", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "meter_output", data: "99", full_addr: "305030", server_name: "north-array", timestamp: 200, provenance: "live" },
  ]);

  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0], {
    parameter: "ac_output",
    value: 2350,
    address: "305003",
    provenance: "live",
    inverterId: "INV-A",
    sourceName: "north-array",
    observedAt: new Date(200_000).toISOString(),
  });
});

test("keeps distinct explicitly identified inverter tags sharing one source register", () => {
  const signals = rawInverterSignals([
    { name: "ac_output", inverter_id: "INV-A", data: "2200", full_addr: "305003", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "ac_output", inverter_id: "INV-B", data: "2100", full_addr: "305003", server_name: "north-array", timestamp: 200, provenance: "live" },
  ]);

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.inverterId).sort(), ["INV-A", "INV-B"]);
});

test("maps reviewed TRN246 inverter identities into separate detail signals without adding them to power aggregation", () => {
  const rows = [1, 2, 3, 4, 5].map((number) => ({
    name: `inv${number}`,
    inverter_id: `inv${number}`,
    measurement_type: "inverter_identity",
    data: 2134,
    full_addr: "305003",
    server_name: "ana",
    timestamp: 200,
    provenance: "live",
  }));
  const identities = rawInverterIdentitySignals(rows);

  assert.deepEqual(identities.map((signal) => signal.inverterId), ["inv1", "inv2", "inv3", "inv4", "inv5"]);
  assert.ok(identities.every((signal) => signal.signalKind === "identity" && signal.address === "305003"));
  assert.equal(rawInverterSignals(rows).length, 0);
  assert.equal(calculateScadaAggregates(rows).acPower.value, null);
});

test("excludes explicitly identified non-power and non-inverter source rows from raw inverter evidence", () => {
  const signals = rawInverterSignals([
    { name: "ac_output", inverter_id: "INV-A", data: "2200", full_addr: "305003", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "temperature", inverter_id: "INV-A", data: "44", full_addr: "305010", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "status", inverter_id: "INV-A", data: "1", full_addr: "305011", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "daily_energy", inverter_id: "INV-A", data: "90", full_addr: "305012", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "ac_output", device_id: "SENSOR-01", data: "999", full_addr: "305013", server_name: "north-array", timestamp: 200, provenance: "live" },
    { name: "temperature", inverter_id: "INV-A", data: "44", full_addr: "305014", server_name: "north-array", timestamp: 200, provenance: "live", semantic: "active_power" },
  ]);

  assert.deepEqual(signals.map((signal) => signal.parameter), ["ac_output"]);
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

test("keeps a saved snapshot through the inclusive 15-minute boundary", () => {
  const now = Date.parse("2026-08-24T04:15:00.000Z");
  const snapshot = parseSavedKpiSnapshot({
    id: 11,
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-24T03:45:00.000Z",
    windowEndedAt: "2026-08-24T04:00:00.000Z",
    scheduledFor: "2026-08-24T04:00:00.000Z",
    capturedAt: "2026-08-24T04:00:00.000Z",
    saveStatus: "saved",
    messageCount: 8,
    parameterCount: 1,
    parameters: [{ name: "actpow", data: 44, full_addr: "305031" }],
    metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
  });

  assert.ok(snapshot);
  assert.equal(now - Date.parse(snapshot.capturedAt), SAVED_KPI_SNAPSHOT_MAX_AGE_MS);
  assert.equal(selectSavedKpiEvidence(snapshot, { now, liveTelemetryFresh: false }).source, "saved");
});

test("removes old, invalid, and incomplete snapshots from fallback display", () => {
  const now = Date.parse("2026-08-24T04:15:00.000Z");
  const base = {
    id: 12,
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-24T03:45:00.000Z",
    windowEndedAt: "2026-08-24T04:00:00.000Z",
    scheduledFor: "2026-08-24T04:00:00.000Z",
    capturedAt: "2026-08-24T04:00:00.000Z",
    messageCount: 8,
    parameterCount: 1,
    parameters: [{ name: "actpow", data: 44, full_addr: "305031" }],
    metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
  };
  const snapshot = (overrides: Record<string, unknown>) => parseSavedKpiSnapshot({ ...base, saveStatus: "saved", ...overrides });

  assert.equal(selectSavedKpiEvidence(snapshot({ capturedAt: "2026-08-24T03:59:59.999Z" }), { now, liveTelemetryFresh: false }).source, "unavailable");
  assert.equal(selectSavedKpiEvidence(snapshot({ capturedAt: "not-a-timestamp" }), { now, liveTelemetryFresh: false }).source, "unavailable");
  assert.equal(selectSavedKpiEvidence(snapshot({ saveStatus: "incomplete" }), { now, liveTelemetryFresh: false }).source, "unavailable");
  assert.equal(selectSavedKpiEvidence(snapshot({ parameters: [] }), { now, liveTelemetryFresh: false }).source, "unavailable");
});

test("fresh live telemetry takes precedence over an eligible saved snapshot", () => {
  const snapshot = parseSavedKpiSnapshot({
    id: 13,
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-24T03:45:00.000Z",
    windowEndedAt: "2026-08-24T04:00:00.000Z",
    scheduledFor: "2026-08-24T04:00:00.000Z",
    capturedAt: "2026-08-24T04:10:00.000Z",
    saveStatus: "saved",
    messageCount: 8,
    parameterCount: 1,
    parameters: [{ name: "actpow", data: 44, full_addr: "305031" }],
    metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
  });

  assert.ok(snapshot);
  const selection = selectSavedKpiEvidence(snapshot, {
    now: Date.parse("2026-08-24T04:15:00.000Z"),
    liveTelemetryFresh: true,
  });
  assert.equal(selection.source, "live");
  assert.equal(selection.snapshot?.id, snapshot.id);
});

test("keeps the latest confirmed saved snapshot as dashboard evidence even after live freshness expires", () => {
  const snapshot = parseSavedKpiSnapshot({
    id: 14,
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-24T03:45:00.000Z",
    windowEndedAt: "2026-08-24T04:00:00.000Z",
    scheduledFor: "2026-08-24T04:00:00.000Z",
    capturedAt: "2026-08-24T04:00:00.000Z",
    saveStatus: "saved",
    messageCount: 8,
    parameterCount: 1,
    parameters: [{ name: "actpow", data: 44, full_addr: "305031" }],
    metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
  });

  assert.ok(snapshot);
  assert.equal(selectSavedKpiEvidence(snapshot, {
    now: Date.parse("2026-08-24T08:00:00.000Z"),
    liveTelemetryFresh: false,
  }).source, "unavailable");
  const dashboardSelection = selectDashboardSavedEvidence(snapshot);
  assert.equal(dashboardSelection.source, "saved");
  assert.equal(dashboardSelection.snapshot?.id, snapshot.id);
});

test("excludes incomplete, empty, and malformed records from dashboard saved evidence", () => {
  const base = {
    id: 15,
    topic: "trn246/modbus",
    windowStartedAt: "2026-08-24T03:45:00.000Z",
    windowEndedAt: "2026-08-24T04:00:00.000Z",
    scheduledFor: "2026-08-24T04:00:00.000Z",
    capturedAt: "2026-08-24T04:00:00.000Z",
    messageCount: 8,
    parameterCount: 1,
    parameters: [{ name: "actpow", data: 44, full_addr: "305031" }],
    metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
  };
  const snapshot = (overrides: Record<string, unknown>) => parseSavedKpiSnapshot({ ...base, saveStatus: "saved", ...overrides });

  assert.equal(selectDashboardSavedEvidence(snapshot({ saveStatus: "incomplete" })).source, "unavailable");
  assert.equal(selectDashboardSavedEvidence(snapshot({ parameters: [] })).source, "unavailable");
  assert.equal(selectDashboardSavedEvidence(snapshot({ capturedAt: "bad timestamp" })).source, "unavailable");
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

test("uses explicitly identified generic inverter source tags in the raw aggregate without promoting their units", () => {
  const totals = calculateScadaAggregates([
    { name: "ac_output", inverter_id: "INV-01", data: "3300", full_addr: "305003", timestamp: 100, provenance: "live" },
    { name: "ac_output", inverter_id: "INV-02", data: "3450", full_addr: "305004", timestamp: 100, provenance: "live" },
  ]);

  assert.equal(totals.acPower.method, "inverter-sum");
  assert.equal(totals.acPower.value, 6750);
  assert.equal(totals.acPower.unit, "raw");
  assert.equal(totals.acPower.included.length, 2);
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

test("uses reviewed daily and cumulative counter roles while preserving their source unit as raw evidence", () => {
  const rows = [
    {
      name: "todayyield",
      data: "40203",
      raw_data: "3430323033",
      reported_unit: "MWh",
      source_counter_role: "daily-counter",
      full_addr: "305003",
      timestamp: 100,
      provenance: "live",
    },
    {
      name: "totalenergy",
      data: "30474240",
      raw_data: "3330343734323430",
      reported_unit: "MWh",
      source_counter_role: "cumulative-counter",
      full_addr: "305008",
      timestamp: 101,
      provenance: "live",
    },
  ];

  const daily = latestRawCounterMetric(rows, "daily-counter");
  const totals = calculateScadaAggregates(rows);

  assert.equal(daily?.value, 40203);
  assert.equal(daily?.sourceUnit, "MWh");
  assert.equal(totals.totalEnergy.value, 30474240);
  assert.equal(totals.totalEnergy.source?.sourceUnit, "MWh");
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

test("uses only an approved plant calibration profile to scale raw live registers", () => {
  const profile = {
    siteName: "trn246/modbus",
    version: "calibration-2026-08-24T10:00:00.000Z",
    status: "approved" as const,
    installedDcCapacityKwp: 50,
    approvedBy: "id:operator",
    approvedAt: "2026-08-24T10:00:00.000Z",
    sources: [
      { role: "acPower" as const, sourceName: "ana", parameter: "actpow", address: "305031", unit: "W" as const, multiplier: 0.1, counterRole: "instantaneous-power" as const, scalingConfirmed: true as const },
      { role: "dailyEnergy" as const, sourceName: "ana", parameter: "dailyeneregykwh", address: "305032", unit: "kWh" as const, multiplier: 0.1, counterRole: "daily-counter" as const, scalingConfirmed: true as const },
      { role: "totalEnergy" as const, sourceName: "ana", parameter: "totalenergy", address: "305008", unit: "kWh" as const, multiplier: 0.1, counterRole: "cumulative-counter" as const, scalingConfirmed: true as const },
    ],
  };
  const kpis = calculateVerifiedScadaKpis([
    { name: "actpow", data: 430000, full_addr: "305031", server_name: "ana", timestamp: 1_000 },
    { name: "dailyeneregykwh", data: 1800, full_addr: "305032", server_name: "ana", timestamp: 1_001 },
    { name: "totalenergy", data: 12200000, full_addr: "305008", server_name: "ana", timestamp: 1_002 },
    { name: "actpow", data: 999999, full_addr: "999999", server_name: "ana", timestamp: 1_003 },
  ], { calibrationProfile: profile, asOf: 1_100_000, maximumAgeMs: 1_000_000 });

  assert.equal(kpis.acPower.value, 43);
  assert.equal(kpis.dailyEnergy.value, 180);
  assert.equal(kpis.totalEnergy.value, 1220000);
  assert.equal(kpis.specificYield.value, 3.6);
  assert.equal(kpis.acPower.profileVersion, profile.version);
  assert.equal(kpis.acPower.inputs[0]?.address, "305031");
});

test("shows draft calibration math without making it a verified KPI", () => {
  const source = {
    role: "acPower" as const,
    sourceName: "ana",
    parameter: "actpow",
    address: "305031",
    unit: "W" as const,
    multiplier: 0.1,
    counterRole: "instantaneous-power" as const,
    scalingConfirmed: true as const,
  };
  const preview = calibrationPreviewCalculation(430000, source);

  assert.equal(preview.scaled, 43000);
  assert.equal(preview.normalizedValue, 43);
  assert.equal(preview.target, "kW");
  assert.match(preview.formula, /430000 × 0.1 W/);

  const kpis = calculateVerifiedScadaKpis([
    { name: "actpow", data: 430000, full_addr: "305031", server_name: "ana", timestamp: 1_000 },
  ], { calibrationProfile: null, asOf: 1_100, maximumAgeMs: 1_000 });
  assert.equal(kpis.acPower.quality, "awaiting-validation");
  assert.equal(kpis.acPower.value, null);
});

test("withholds engineering KPIs when the plant has no approved calibration profile", () => {
  const kpis = calculateVerifiedScadaKpis([
    { name: "actpow", data: 43000, full_addr: "305031", server_name: "ana", timestamp: 1_000 },
  ], { calibrationProfile: null, asOf: 1_100, maximumAgeMs: 1_000 });
  assert.equal(kpis.acPower.quality, "awaiting-validation");
  assert.match(kpis.acPower.readiness, /No approved plant calibration profile/i);
});

test("verifies an approved total-energy source without inventing plant capacity or specific yield", () => {
  const kpis = calculateVerifiedScadaKpis([
    { name: "totalenergy", data: 30474240, full_addr: "305008", server_name: "ana", timestamp: 1_000 },
  ], {
    calibrationProfile: {
      siteName: "trn246/modbus",
      version: "calibration-total-energy-only",
      status: "approved",
      installedDcCapacityKwp: null,
      approvedBy: "explicit-user-approval",
      approvedAt: "2026-08-25T06:30:00.000Z",
      sources: [{
        role: "totalEnergy",
        sourceName: "ana",
        parameter: "totalenergy",
        address: "305008",
        unit: "MWh",
        multiplier: 0.001,
        counterRole: "cumulative-counter",
        scalingConfirmed: true,
      }],
    },
    asOf: 1_100_000,
    maximumAgeMs: 1_000_000,
  });

  assert.equal(kpis.totalEnergy.quality, "verified");
  assert.equal(kpis.totalEnergy.value, 30474240);
  assert.equal(kpis.totalEnergy.unit, "kWh");
  assert.equal(kpis.dailyEnergy.quality, "awaiting-validation");
  assert.equal(kpis.specificYield.quality, "awaiting-validation");
  assert.match(kpis.specificYield.readiness, /daily-energy counter/i);
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
      capturedAt: "2026-08-24T04:15:42.000Z",
    },
  });
  const live = calculateVerifiedScadaKpis([
    { name: "actpow", data: 2000, full_addr: "305031", timestamp: 200, scaling_validated: true, unit: "W", semantic: "active_power" },
  ]);

  assert.equal(snapshot.acPower.provenance, "snapshot");
  assert.equal(snapshot.acPower.snapshotWindow?.scheduledFor, "2026-08-24T04:15:00.000Z");
  assert.equal(snapshot.acPower.snapshotWindow?.capturedAt, "2026-08-24T04:15:42.000Z");
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

test("uses only fresh, explicitly mapped validated inverter records for live contribution", () => {
  const fleet = assessValidatedLiveInverterFleet([
    { name: "inv1", inverter_id: "INV-01", inverter_name: "Inverter 01", data: 3.2, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "live" },
    { name: "inv2", inverter_id: "INV-02", data: 1_800, unit: "W", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "live" },
    { name: "inv3", inverter_id: "INV-03", data: 4, unit: "kW", semantic: "active_power", timestamp: 1_000, provenance: "live" },
    { name: "inv4", inverter_id: "INV-04", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 100, provenance: "live" },
    { name: "inv5", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "live" },
    { name: "inv6", inverter_id: "INV-06", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "replay" },
    { name: "inv7", inverter_id: "INV-07", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "retained" },
    { name: "inv8", inverter_id: "INV-08", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_001, provenance: "live" },
  ], { asOf: 1_000_000, maximumAgeMs: 100 });

  assert.equal(fleet.records.length, 2);
  assert.equal(fleet.totalKw, 5);
  assert.deepEqual(fleet.records.map((record) => record.inverterId).sort(), ["INV-01", "INV-02"]);
  assert.equal(fleet.excluded.length, 6);
  assert.ok(fleet.excluded.some((item) => item.reason.includes("Scaling")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("stale")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("identity")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("replayed")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("retained")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("future")));
});

test("keeps the fleet operational model on API-validated source records only", () => {
  const fleet = assessSourceBackedInverterFleet([
    {
      inverterId: "INV-01", inverterName: "Inverter 01", parameter: "inv1", value: 3.2, rawValue: "3200",
      unit: "kW", semantic: "active-power", scalingStatus: "validated", sourceName: "MQTT", address: "305003",
      sourceTimestamp: new Date(1_000_000).toISOString(), provenance: "live",
    },
    {
      inverterId: "INV-02", inverterName: "Inverter 02", parameter: "inv2", value: 4, rawValue: "4000",
      unit: "kW", semantic: "active-power", scalingStatus: "validated", sourceName: "MQTT", address: "305004",
      sourceTimestamp: new Date(1_000_000).toISOString(), provenance: "retained",
    },
  ], { asOf: 1_000_000, maximumAgeMs: 100 });

  assert.deepEqual(fleet.records.map((record) => record.inverterId), ["INV-01"]);
  assert.equal(fleet.totalKw, 3.2);
  assert.ok(fleet.excluded.some((item) => item.inverterId === "INV-02"));
});

test("uses only validated, semantic-mapped inverter records from a saved snapshot's own window, regardless of provenance", () => {
  const fleet = assessValidatedSavedInverterFleet([
    { name: "inv1", inverter_id: "INV-01", inverter_name: "Inverter 01", data: 3.2, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "retained" },
    { name: "inv2", inverter_id: "INV-02", data: 1_800, unit: "W", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "live" },
    { name: "inv3", inverter_id: "INV-03", data: 4, unit: "kW", semantic: "active_power", timestamp: 1_000, provenance: "retained" },
    { name: "inv4", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 1_000, provenance: "retained" },
    { name: "inv5", inverter_id: "INV-05", data: 4, unit: "kW", semantic: "active_power", scaling_validated: true, timestamp: 100, provenance: "retained" },
  ], { asOf: 1_000_000, maximumAgeMs: 100 });

  assert.equal(fleet.records.length, 2);
  assert.equal(fleet.totalKw, 5);
  assert.deepEqual(fleet.records.map((record) => record.inverterId).sort(), ["INV-01", "INV-02"]);
  assert.ok(fleet.records.every((record) => record.provenance === "saved"));
  assert.equal(fleet.excluded.length, 3);
  assert.ok(fleet.excluded.some((item) => item.reason.includes("Scaling")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("identity")));
  assert.ok(fleet.excluded.some((item) => item.reason.includes("collection window")));
});