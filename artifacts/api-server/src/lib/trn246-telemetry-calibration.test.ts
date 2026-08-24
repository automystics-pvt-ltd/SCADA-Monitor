import assert from "node:assert/strict";
import test from "node:test";
import { applyTrn246TelemetryCalibration } from "./trn246-telemetry-calibration.ts";

test("converts approved TRN246 active power to kW while retaining the source value", () => {
  const calibrated = applyTrn246TelemetryCalibration({
    name: "actpow",
    data: 2_015_690_752,
    full_addr: "305031",
    server_name: "ana",
  });

  assert.equal(calibrated.data, 20_156.90752);
  assert.equal(calibrated.source_raw_value, 2_015_690_752);
  assert.equal(calibrated.engineering_unit, "kW");
  assert.equal(calibrated.semantic, "active_power");
  assert.equal(calibrated.scaling_validated, true);
});

test("converts approved TRN246 counters to MWh", () => {
  const calibrated = applyTrn246TelemetryCalibration({
    name: "totalenergy",
    data: 31_457_280,
    full_addr: "305008",
    server_name: "ana",
  });

  assert.equal(calibrated.data, 31_457.28);
  assert.equal(calibrated.engineering_unit, "MWh");
  assert.equal(calibrated.semantic, "cumulative_energy");
});

test("marks the invN identity register without promoting it to power", () => {
  const calibrated = applyTrn246TelemetryCalibration({
    name: "inv1",
    data: 12_855,
    full_addr: "305003",
    server_name: "ana",
  });

  assert.equal(calibrated.measurement_type, "inverter_identity");
  assert.equal(calibrated.scaling_validated, undefined);
});