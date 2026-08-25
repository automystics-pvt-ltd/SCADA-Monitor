import assert from "node:assert/strict";
import test from "node:test";
import { telemetryMappingRequiresDisplayUnit } from "./telemetry-mapping-policy";

test("allows event and state mappings to remain explicitly unitless", () => {
  for (const destination of ["inverter-identity", "alarm", "fault", "communication", "data-quality"]) {
    assert.equal(telemetryMappingRequiresDisplayUnit(destination), false);
  }
});

test("requires a confirmed display unit for numeric engineering destinations", () => {
  for (const destination of ["active-power", "voltage", "daily-energy", "environmental", "discovered-other"]) {
    assert.equal(telemetryMappingRequiresDisplayUnit(destination), true);
  }
});