import assert from "node:assert/strict";
import test from "node:test";
import { deviceCommunicationState, latestBootstrapMessages, medianCadenceMs, recoveryNeedsResync, retainValidSourceTimestamp, sourceTimestampIso, telemetryParameterFromRawPayload } from "./telemetry-reliability.ts";

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

test("bootstraps a new monitor with bounded latest signal evidence", () => {
  const messages = Array.from({ length: 1_000 }, (_, index) => ({
    sequence: index + 1,
    signal: `register-${index % 4}`,
  }));

  const bootstrap = latestBootstrapMessages(messages, (message) => message.signal, 120);

  assert.deepEqual(bootstrap.map((message) => message.sequence), [997, 998, 999, 1_000]);
  assert.equal(bootstrap.length, 4);
});

test("keeps bounded bootstrap evidence in delivery order", () => {
  const messages = [
    { sequence: 1, signal: "a" },
    { sequence: 2, signal: "b" },
    { sequence: 3, signal: "c" },
    { sequence: 4, signal: "d" },
  ];

  const bootstrap = latestBootstrapMessages(messages, (message) => message.signal, 2);

  assert.deepEqual(bootstrap.map((message) => message.sequence), [3, 4]);
});

test("preserves malformed payload evidence without treating it as a telemetry parameter", () => {
  assert.equal(telemetryParameterFromRawPayload("not-json"), undefined);
  assert.equal(telemetryParameterFromRawPayload('{"Automystics":{"name":"actpow","data":"12"}}')?.name, "actpow");
});

test("rejects unrepresentable source clocks and formats a following live observation safely", () => {
  const first = retainValidSourceTimestamp(undefined, { timestamp: "1724480000" });
  const afterInvalidNumber = retainValidSourceTimestamp(first, { timestamp: 999_999_999_999_999_999_999 });
  const afterInvalidString = retainValidSourceTimestamp(afterInvalidNumber, { timestamp: "999999999999999999999" });
  const followingObservation = retainValidSourceTimestamp(afterInvalidString, { timestamp: "1724480060" });

  assert.equal(first, 1_724_480_000_000);
  assert.equal(sourceTimestampIso(999_999_999_999_999_999_999), undefined);
  assert.equal(sourceTimestampIso("999999999999999999999"), undefined);
  assert.equal(afterInvalidNumber, first);
  assert.equal(afterInvalidString, first);
  assert.equal(followingObservation, 1_724_480_060_000);
  assert.equal(sourceTimestampIso("1724480060"), "2024-08-24T06:14:20.000Z");
});