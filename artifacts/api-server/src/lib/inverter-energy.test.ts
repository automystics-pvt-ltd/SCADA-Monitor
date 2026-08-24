import assert from "node:assert/strict";
import test from "node:test";
import { inverterActivePowerObservationFromParameter, inverterEnergyObservationFromParameter, inverterMeasurementObservationFromParameter } from "./inverter-energy.ts";

const sourceSite = "trn246/modbus";

function trn246InverterYield(overrides: Record<string, unknown> = {}) {
  return {
    name: "inv1",
    data: "3419",
    raw_data: "33343139",
    full_addr: "305003",
    server_name: "ana",
    date_iso_8601: "2026-08-24T11:04:31+0530",
    ...overrides,
  };
}

test("accepts the explicitly mapped TRN246 per-inverter yield register with raw scaling evidence", () => {
  const observation = inverterEnergyObservationFromParameter(trn246InverterYield(), sourceSite);
  assert.deepEqual(observation && {
    siteName: observation.siteName,
    inverterId: observation.inverterId,
    value: observation.value,
    address: observation.address,
    scalingStatus: observation.scalingStatus,
    sourceMapping: observation.metadata.sourceMapping,
  }, {
    siteName: sourceSite,
    inverterId: "inv1",
    value: 3419,
    address: "305003",
    scalingStatus: "raw",
    sourceMapping: "ana/305003/invN",
  });
});

test("rejects bare inverter tags that do not match the trusted source/register mapping", () => {
  assert.equal(inverterEnergyObservationFromParameter(trn246InverterYield({ full_addr: "999999" }), sourceSite), undefined);
  assert.equal(inverterEnergyObservationFromParameter(trn246InverterYield({ server_name: "unknown-source" }), sourceSite), undefined);
});

test("rejects source-declared site data that conflicts with the configured MQTT site scope", () => {
  assert.equal(inverterEnergyObservationFromParameter(trn246InverterYield({ site_name: "Other plant" }), sourceSite), undefined);
});

test("creates a validated active-power record only from explicit inverter mapping", () => {
  const observation = inverterActivePowerObservationFromParameter(trn246InverterYield({
    inverter_id: "INV-A-01",
    inverter_name: "Inverter A01",
    semantic: "active_power",
    engineering_unit: "W",
    scaling_validated: true,
    data: 3_450,
  }), sourceSite);

  assert.deepEqual(observation && {
    inverterId: observation.inverterId,
    inverterName: observation.inverterName,
    value: observation.value,
    unit: observation.unit,
    activePowerSemantic: observation.activePowerSemantic,
    scalingStatus: observation.scalingStatus,
  }, {
    inverterId: "INV-A-01",
    inverterName: "Inverter A01",
    value: 3.45,
    unit: "kW",
    activePowerSemantic: "active-power",
    scalingStatus: "validated",
  });
});

test("refuses active-power records missing any approved source mapping field", () => {
  const base = {
    inverter_id: "INV-A-01",
    semantic: "active_power",
    engineering_unit: "kW",
    scaling_validated: true,
  };
  assert.ok(inverterActivePowerObservationFromParameter(trn246InverterYield(base), sourceSite));
  assert.equal(inverterActivePowerObservationFromParameter(trn246InverterYield({ ...base, inverter_id: undefined }), sourceSite), undefined);
  assert.equal(inverterActivePowerObservationFromParameter(trn246InverterYield({ ...base, semantic: undefined }), sourceSite), undefined);
  assert.equal(inverterActivePowerObservationFromParameter(trn246InverterYield({ ...base, engineering_unit: undefined }), sourceSite), undefined);
  assert.equal(inverterActivePowerObservationFromParameter(trn246InverterYield({ ...base, scaling_validated: false }), sourceSite), undefined);
});

test("refuses a future-dated active-power record", () => {
  assert.equal(inverterActivePowerObservationFromParameter(trn246InverterYield({
    inverter_id: "INV-A-01",
    semantic: "active_power",
    engineering_unit: "kW",
    scaling_validated: true,
    date_iso_8601: "2099-08-24T11:04:31Z",
  }), sourceSite), undefined);
});

test("refuses a plant-conflicting active-power record before it reaches the live fleet stream", () => {
  assert.equal(inverterActivePowerObservationFromParameter(trn246InverterYield({
    inverter_id: "INV-A-01",
    semantic: "active_power",
    engineering_unit: "kW",
    scaling_validated: true,
    site_name: "different-plant/modbus",
  }), sourceSite), undefined);
});

test("archives explicitly attributed inverter measurement points with source traceability", () => {
  const measurement = inverterMeasurementObservationFromParameter({
    name: "phase_a_current",
    inverter_id: "inv-01",
    inverter_name: "Inverter 01",
    site_name: sourceSite,
    data: "4.60",
    raw_data: "460",
    unit: "A",
    full_addr: "305031",
    server_name: "ana",
    timestamp: "2026-08-24T10:00:00.000Z",
  }, sourceSite);

  assert.deepEqual(measurement && {
    inverterId: measurement.inverterId,
    parameter: measurement.parameter,
    measurementKind: measurement.measurementKind,
    value: measurement.value,
    rawValue: measurement.rawValue,
    unit: measurement.unit,
    scalingStatus: measurement.scalingStatus,
  }, {
    inverterId: "inv-01",
    parameter: "phase_a_current",
    measurementKind: "electrical",
    value: 4.6,
    rawValue: "460",
    unit: "A",
    scalingStatus: "raw",
  });
});

test("converts only validated explicit inverter active-power measurements to kW", () => {
  const measurement = inverterMeasurementObservationFromParameter(trn246InverterYield({
    inverter_id: "inv-01",
    semantic: "active_power",
    engineering_unit: "W",
    scaling_validated: true,
    data: 24_500,
    raw_data: "24500",
  }), sourceSite);

  assert.equal(measurement?.measurementKind, "active-power");
  assert.equal(measurement?.value, 24.5);
  assert.equal(measurement?.unit, "kW");
  assert.equal(measurement?.scalingStatus, "validated");
});

test("does not archive measurements without explicit inverter identity", () => {
  assert.equal(inverterMeasurementObservationFromParameter(trn246InverterYield({
    inverter_id: undefined,
    data: 4.6,
    unit: "A",
  }), sourceSite), undefined);
});