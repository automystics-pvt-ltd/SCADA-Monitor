import assert from "node:assert/strict";
import test from "node:test";
import { applyTelemetryMappings, createTelemetryMappingStore, type ScadaTelemetryMapping } from "./telemetry-mappings.ts";

const mapping: ScadaTelemetryMapping = {
  id: "map-1",
  deviceId: "INV-01",
  sourceIdentity: "Solar gateway|actpow|305003",
  sourceName: "Solar gateway",
  normalizedName: "actpow",
  address: "305003",
  destination: "active-power",
  displayLabel: "Inverter 1 AC output",
  category: "power",
  inverterIdentity: "inv1",
  sourceUnit: "kW",
  version: 3,
};

test("applies a managed mapping only to its exact source and device evidence", () => {
  const [mapped, otherDevice, otherRegister] = applyTelemetryMappings([
    { name: "Act Pow", data: "120.5", server_name: "Solar gateway", full_addr: "305003", device_id: "INV-01", reported_unit: "kW" },
    { name: "Act Pow", data: "99", server_name: "Solar gateway", full_addr: "305003", device_id: "INV-02" },
    { name: "Act Pow", data: "88", server_name: "Solar gateway", full_addr: "305004", device_id: "INV-01" },
  ], [mapping]);

  assert.deepEqual(
    { destination: mapped?.admin_mapping_destination, inverter: mapped?.inverter_id, version: mapped?.admin_mapping_version },
    { destination: "active-power", inverter: "inv1", version: 3 },
  );
  assert.equal(mapped?.data, "120.5");
  assert.equal(mapped?.reported_unit, "kW");
  assert.equal(otherDevice?.admin_mapping_destination, undefined);
  assert.equal(otherRegister?.admin_mapping_destination, undefined);
});

test("does not map device-less source evidence when the source/register match is ambiguous", () => {
  const secondDeviceMapping = { ...mapping, id: "map-2", deviceId: "INV-02", inverterIdentity: "inv2" };
  const [unresolved] = applyTelemetryMappings([
    { name: "Act Pow", data: "120.5", server_name: "Solar gateway", full_addr: "305003" },
  ], [mapping, secondDeviceMapping]);

  assert.equal(unresolved?.admin_mapping_destination, undefined);
  assert.equal(unresolved?.inverter_id, undefined);
});

test("removes mapping-derived semantics immediately after a mapping is cleared", () => {
  const rawRow = { name: "Act Pow", data: "120.5", server_name: "Solar gateway", full_addr: "305003", device_id: "INV-01" };
  const [mapped] = applyTelemetryMappings([rawRow], [mapping]);
  const [cleared] = applyTelemetryMappings([mapped!], []);

  assert.equal(mapped?.admin_mapping_destination, "active-power");
  assert.equal(mapped?.inverter_id, "inv1");
  assert.equal(cleared?.admin_mapping_destination, undefined);
  assert.equal(cleared?.inverter_id, undefined);
  assert.equal(cleared?.reported_unit, undefined);
  assert.equal(cleared?.data, "120.5");
});

test("uses a mapping loaded after a long-lived consumer has already started", () => {
  const store = createTelemetryMappingStore();
  const rawRow = { name: "Act Pow", data: "120.5", server_name: "Solar gateway", full_addr: "305003", device_id: "INV-01" };

  const [beforeLoad] = store.apply([rawRow]);
  store.setMappings([mapping]);
  const [nextLiveFrame] = store.apply([rawRow]);
  store.setMappings([]);
  const [afterClear] = store.apply([nextLiveFrame!]);

  assert.equal(beforeLoad?.admin_mapping_destination, undefined);
  assert.equal(nextLiveFrame?.admin_mapping_destination, "active-power");
  assert.equal(afterClear?.admin_mapping_destination, undefined);
  assert.equal(afterClear?.inverter_id, undefined);
});