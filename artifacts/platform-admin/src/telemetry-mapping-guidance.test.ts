import assert from "node:assert/strict";
import test from "node:test";
import { isUnitlessTelemetryDestination, telemetryMappingGuidance } from "./telemetry-mapping-guidance.ts";

test("guides unitless alarm mappings without asking an administrator to invent a unit", () => {
  const guidance = telemetryMappingGuidance("alarm", "alarm", null);
  assert.equal(guidance.unitless, true);
  assert.equal(guidance.recommendedCategory, "Alarms / Faults");
  assert.equal(guidance.frontEndDisplay, "Alarms & Events and source evidence");
  assert.deepEqual(guidance.unitSuggestions, []);
  assert.equal(isUnitlessTelemetryDestination("alarm"), true);
});

test("keeps the reported unit first for numeric mapping guidance", () => {
  const guidance = telemetryMappingGuidance("active-power", "Act Pow", "kW");
  assert.equal(guidance.unitless, false);
  assert.deepEqual(guidance.unitSuggestions, ["kW", "W", "MW"]);
  assert.match(guidance.frontEndDisplay, /power distribution/i);
});