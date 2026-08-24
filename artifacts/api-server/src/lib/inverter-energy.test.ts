import assert from "node:assert/strict";
import test from "node:test";
import { inverterEnergyObservationFromParameter } from "./inverter-energy.ts";

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