import assert from "node:assert/strict";
import test from "node:test";
import { inverterActivePowerObservationFromParameter, inverterEnergyObservationFromParameter } from "./inverter-energy.ts";

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