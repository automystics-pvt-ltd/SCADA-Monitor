import assert from "node:assert/strict";
import test from "node:test";
import { deviceCommunicationState, medianCadenceMs, recoveryNeedsResync, telemetryParameterFromRawPayload } from "./telemetry-reliability.ts";

test("derives heartbeat health from observed server receipt cadence", () => {
  const cadence = medianCadenceMs([950, 1_000, 1_050, 1_000, 980]);
  assert.equal(cadence, 1_000);
  assert.equal(deviceCommunicationState(10_000, 12_999, cadence).state, "live");
  assert.equal(deviceCommunicationState(10_000, 45_000, cadence).state, "stale");
  assert.equal(deviceCommunicationState(10_000, 190_001, cadence).state, "interrupted");
});

test("awaits first data and requests an explicit resync only when recovery evidence is exhausted", () => {
  assert.equal(deviceCommunicationState(undefined, 1_000, undefined).state, "awaiting-first-data");
  assert.equal(recoveryNeedsResync(10, 13, [11, 12, 13]), false);
  assert.equal(recoveryNeedsResync(10, 13, [11, 13]), true);
  assert.equal(recoveryNeedsResync(10, 13, []), true);
  assert.equal(recoveryNeedsResync(undefined, 13, []), false);
});

test("preserves malformed payload evidence without treating it as a telemetry parameter", () => {
  assert.equal(telemetryParameterFromRawPayload("not-json"), undefined);
  assert.equal(telemetryParameterFromRawPayload('{"Automystics":{"name":"actpow","data":"12"}}')?.name, "actpow");
});