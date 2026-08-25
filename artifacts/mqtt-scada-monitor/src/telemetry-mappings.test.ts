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
  displayUnit: "kW",
  scalingMultiplier: 1,
  scalingOffset: 0,
  scalingStatus: "approved",
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
  const rawRow = { name: "Act Pow", data: "120.5", reported_value: "120.5", source_mapping_status: "source-reported", server_name: "Solar gateway", full_addr: "305003", device_id: "INV-01" };
  const [mapped] = applyTelemetryMappings([rawRow], [mapping]);
  const [cleared] = applyTelemetryMappings([mapped!], []);

  assert.equal(mapped?.admin_mapping_destination, "active-power");
  assert.equal(mapped?.inverter_id, "inv1");
  assert.equal(cleared?.admin_mapping_destination, undefined);
  assert.equal(cleared?.inverter_id, undefined);
  assert.equal(cleared?.reported_unit, undefined);
  assert.equal(cleared?.display_value, undefined);
  assert.equal(cleared?.admin_mapping_scaling_status, undefined);
  assert.equal(cleared?.data, "120.5");
});

test("clears a server-resolved display transform from already visible evidence", () => {
  const serverResolvedRow = {
    name: "Act Pow",
    data: "120.5",
    reported_value: "120.5",
    source_mapping_status: "source-reported",
    display_value: 120_500,
    display_unit: "W",
    admin_mapping_id: "map-1",
    admin_mapping_destination: "active-power",
    admin_mapping_scaling_status: "approved",
    admin_mapping_validation_status: "valid",
    server_name: "Solar gateway",
    full_addr: "305003",
    device_id: "INV-01",
  };
  const [cleared] = applyTelemetryMappings([serverResolvedRow], []);

  assert.equal(cleared?.display_value, undefined);
  assert.equal(cleared?.display_unit, undefined);
  assert.equal(cleared?.admin_mapping_destination, undefined);
  assert.equal(cleared?.reported_value, "120.5");
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

test("reapplies a saved mapping revision to rows already visible on the dashboard", () => {
  const store = createTelemetryMappingStore();
  const rawRow = { name: "Act Pow", data: "120.5", server_name: "Solar gateway", full_addr: "305003", device_id: "INV-01" };
  store.setMappings([mapping]);
  const [initial] = store.apply([rawRow]);
  const revised = {
    ...mapping,
    destination: "voltage",
    displayLabel: "AC voltage review",
    inverterIdentity: null,
    version: 4,
  };
  store.setMappings([revised]);
  const [updated] = store.apply([initial!]);

  assert.equal(updated?.admin_mapping_destination, "voltage");
  assert.equal(updated?.admin_mapping_label, "AC voltage review");
  assert.equal(updated?.admin_mapping_version, 4);
  assert.equal(updated?.inverter_id, undefined);
});

test("uses saved label, unit, and transform for source-reported evidence only", () => {
  const [mapped] = applyTelemetryMappings([{
    name: "Act Pow",
    data: "12500",
    reported_value: "12.5",
    source_mapping_status: "source-reported",
    server_name: "Solar gateway",
    full_addr: "305003",
    device_id: "INV-01",
  }], [{ ...mapping, displayUnit: "W", scalingMultiplier: 1_000, scalingOffset: 5 }]);

  assert.equal(mapped?.admin_mapping_label, "Inverter 1 AC output");
  assert.equal(mapped?.display_value, 12_505);
  assert.equal(mapped?.display_unit, "W");
  assert.equal(mapped?.data, "12500");
  assert.equal(mapped?.reported_value, "12.5");
});

test("maps retained discovered evidence by its camel-case source identity fields", () => {
  const [mapped] = applyTelemetryMappings([{
    normalizedName: "actpow",
    sourceName: "Solar gateway",
    address: "305003",
    deviceId: "INV-01",
    rawValue: "120.5",
    reportedValue: "120.5",
  }], [mapping]);

  assert.equal(mapped?.admin_mapping_destination, "active-power");
  assert.equal(mapped?.inverter_id, "inv1");
  assert.equal(mapped?.rawValue, "120.5");
  assert.equal(mapped?.reportedValue, "120.5");
});