import assert from "node:assert/strict";
import test from "node:test";
import { deviceParameterFreshness, discoverDeviceParameters, latestDeviceParameterWins } from "./device-parameter-discovery";

const context = {
  siteName: "TRN246",
  topic: "trn246/modbus",
  receivedAt: "2026-08-25T09:00:05.000Z",
  provenance: "live" as const,
};

test("discovers nested, repeated, and non-numeric source parameters without assigning unsafe engineering quality", () => {
  const parameters = discoverDeviceParameters({
    site_name: "TRN246",
    devices: [
      { device_id: "inv-a", device_name: "Inverter A", mppt: { voltage: 710, current: 8.2 }, state: "running" },
      { device_id: "inv-b", device_name: "Inverter B", mppt: { voltage: 706, current: 8.1 }, state: "waiting" },
    ],
  }, context);

  assert.equal(parameters.length, 6);
  assert.equal(parameters.filter((parameter) => parameter.deviceId === "inv-a").length, 3);
  assert.equal(parameters.filter((parameter) => parameter.category === "MPPT / Strings").length, 4);
  assert.equal(parameters.find((parameter) => parameter.originalName.endsWith("state"))?.dataQuality, "source-reported");
  assert.ok(parameters.every((parameter) => parameter.scalingStatus === "raw"));
});

test("prioritizes explicit metadata and keeps ambiguous fields in discovered other", () => {
  const parameters = discoverDeviceParameters({
    name: "mystery_output",
    data: "14.7",
    device_id: "inv-a",
    measurement_type: "energy",
    unit: "kWh",
    scaling_validated: true,
    timestamp: "2026-08-25T09:00:00.000Z",
  }, context);
  assert.equal(parameters[0]?.category, "Energy");
  assert.equal(parameters[0]?.dataQuality, "validated");
  assert.equal(parameters[0]?.value, 14.7);

  const unknown = discoverDeviceParameters({ name: "channel_12", data: 9, device_id: "inv-a" }, context);
  assert.equal(unknown[0]?.category, "Discovered / Other Parameters");
  assert.equal(unknown[0]?.dataQuality, "raw");
});

test("walks parameter containers instead of discarding nested source evidence", () => {
  const wrapped = discoverDeviceParameters({
    device_id: "inv-a",
    data: { dc_voltage: 702, operating_state: "running" },
  }, context);
  assert.deepEqual(wrapped.map((parameter) => parameter.originalName).sort(), ["data.dc_voltage", "data.operating_state"]);
  assert.equal(wrapped.find((parameter) => parameter.originalName.endsWith("operating_state"))?.rawValue, "running");

  const namedContainer = discoverDeviceParameters({
    name: "mppt_block",
    data: { voltage: 710, current: 8.2 },
    device_id: "inv-a",
  }, context);
  assert.equal(namedContainer.length, 3);
  assert.ok(namedContainer.some((parameter) => parameter.originalName === "mppt_block"));
  assert.ok(namedContainer.some((parameter) => parameter.originalName.endsWith("voltage")));
});

test("does not assign energy semantics from incidental character sequences", () => {
  const switchStatus = discoverDeviceParameters({ name: "switch_status", data: "closed", device_id: "inv-a" }, context)[0];
  assert.equal(switchStatus?.category, "Discovered / Other Parameters");
});

test("does not accept root or nested payload metadata that conflicts with the configured capture site", () => {
  const rootConflict = discoverDeviceParameters({
    site_name: "Other Site",
    name: "dc_voltage",
    data: 701,
    device_id: "inv-a",
  }, context);
  assert.equal(rootConflict.length, 0);

  const nestedConflict = discoverDeviceParameters({
    site_name: "TRN246",
    devices: [
      { site_name: "Other Site", device_id: "inv-a", name: "dc_voltage", data: 701 },
      { site_name: "TRN246", device_id: "inv-b", name: "dc_voltage", data: 702 },
    ],
  }, context);
  assert.equal(nestedConflict.length, 1);
  assert.equal(nestedConflict[0]?.deviceId, "inv-b");
  assert.equal(nestedConflict[0]?.siteName, "TRN246");
});

test("uses source identity, timestamps, and raw values in deterministic observation identities", () => {
  const payload = { name: "phase_voltage", data: 401, device_id: "inv-a", addr: "40001", date_iso_8601: "2026-08-25T09:00:00.000Z" };
  const first = discoverDeviceParameters(payload, context)[0];
  const second = discoverDeviceParameters(payload, context)[0];
  const changed = discoverDeviceParameters({ ...payload, data: 402 }, context)[0];
  assert.equal(first?.observationId, second?.observationId);
  assert.notEqual(first?.observationId, changed?.observationId);
  assert.equal(first?.signalKey, changed?.signalKey);
  assert.equal(first?.observedAt, "2026-08-25T09:00:00.000Z");
});

test("keeps direct live evidence ahead of recovery or saved evidence and rejects future source clocks as current", () => {
  const live = discoverDeviceParameters({ name: "dc_voltage", data: 710, device_id: "inv-a", date_iso_8601: "2026-08-25T09:00:00.000Z" }, context)[0]!;
  const recovered = { ...live, provenance: "recovered" as const, receivedAt: "2026-08-25T09:01:00.000Z" };
  const snapshot = { ...live, provenance: "snapshot" as const, receivedAt: "2026-08-25T09:02:00.000Z" };
  assert.equal(latestDeviceParameterWins(live, recovered), false);
  assert.equal(latestDeviceParameterWins(live, snapshot), false);
  assert.deepEqual(deviceParameterFreshness(live, Date.parse("2026-08-25T09:00:20.000Z")), { ageMs: 20_000, freshness: "live" });
  assert.equal(deviceParameterFreshness(live, Date.parse("2026-08-25T09:00:31.000Z")).freshness, "stale");
  assert.equal(deviceParameterFreshness({ ...live, observedAt: "2026-08-25T09:01:00.000Z" }, Date.parse("2026-08-25T09:00:00.000Z")).freshness, "stale");
});