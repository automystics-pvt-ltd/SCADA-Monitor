import assert from "node:assert/strict";
import test from "node:test";
import { PlatformTelemetryDestination } from "@workspace/api-client-react";
import { inverterIdentityForMapping, requiresInverterIdentity } from "./telemetry-mapping-form.ts";

test("keeps inv1 through inv5 attribution on active-power mappings", () => {
  assert.equal(requiresInverterIdentity(PlatformTelemetryDestination["active-power"]), true);
  assert.equal(inverterIdentityForMapping(PlatformTelemetryDestination["active-power"], "inv3"), "inv3");
});

test("does not attach inverter attribution to non-inverter destinations", () => {
  assert.equal(requiresInverterIdentity(PlatformTelemetryDestination["daily-energy"]), false);
  assert.equal(inverterIdentityForMapping(PlatformTelemetryDestination["daily-energy"], "inv3"), null);
});