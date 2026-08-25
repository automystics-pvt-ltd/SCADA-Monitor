import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformTelemetryMapping } from "@workspace/db";
import type { DiscoveredDeviceParameter } from "./device-parameter-discovery";
import { applyActiveTelemetryMappings } from "./telemetry-mapping-resolution";

const parameter: DiscoveredDeviceParameter = {
  observationId: "parameter:one",
  signalKey: "Plant A|INV-01|vendorpower|40001",
  siteName: "Plant A",
  deviceId: "INV-01",
  deviceName: "Inverter 01",
  topic: "plant/telemetry",
  originalName: "vendor_power",
  normalizedName: "vendorpower",
  displayLabel: "vendor power",
  category: "Discovered / Other Parameters",
  rawValue: "18250",
  reportedValue: "18.25",
  reportedNumericValue: 18.25,
  value: 18.25,
  unit: null,
  sourceUnit: null,
  address: "40001",
  sourceName: "Gateway A",
  sourceIdentity: "Plant A|Gateway A|vendorpower|40001",
  sourceMappingStatus: "raw",
  observedAt: "2026-08-25T07:00:00.000Z",
  receivedAt: "2026-08-25T07:00:01.000Z",
  provenance: "live",
  dataQuality: "raw",
  scalingStatus: "raw",
};

function mapping(overrides: Partial<PlatformTelemetryMapping> = {}): PlatformTelemetryMapping {
  return {
    id: "mapping-1",
    siteName: "Plant A",
    deviceId: "INV-01",
    sourceIdentity: "Plant A|Gateway A|vendorpower|40001",
    sourceName: "Gateway A",
    normalizedName: "vendorpower",
    address: "40001",
    destination: "active-power",
    displayLabel: "Inverter AC power",
    category: "not-a-supported-category",
    inverterIdentity: "inv1",
    sourceUnit: "kW",
    displayUnit: "kW",
    scalingMultiplier: 1,
    scalingOffset: 0,
    scalingStatus: "approved",
    status: "active",
    version: 3,
    createdBy: "admin-1",
    updatedBy: "admin-1",
    clearedAt: null,
    createdAt: new Date("2026-08-25T07:00:00.000Z"),
    updatedAt: new Date("2026-08-25T07:00:00.000Z"),
    ...overrides,
  };
}

test("applies only one exact active map without altering the reported source evidence", () => {
  const [resolved] = applyActiveTelemetryMappings([parameter], [mapping()]);
  assert.equal(resolved.displayLabel, "Inverter AC power");
  assert.equal(resolved.category, "Electrical");
  assert.equal(resolved.sourceUnit, "kW");
  assert.equal(resolved.unit, "kW");
  assert.equal(resolved.adminMappingDestination, "active-power");
  assert.equal(resolved.inverterIdentity, "inv1");
  assert.equal(resolved.rawValue, "18250");
  assert.equal(resolved.reportedValue, "18.25");
  assert.equal(resolved.scalingStatus, "raw");
  assert.equal(resolved.displayValue, "18.25");
  assert.equal(resolved.displayUnit, "kW");
  assert.equal(resolved.adminMappingValidationStatus, "valid");
});

test("creates a separate approved display value without replacing raw or reported evidence", () => {
  const [resolved] = applyActiveTelemetryMappings([parameter], [mapping({
    displayUnit: "W",
    scalingMultiplier: 1_000,
    scalingOffset: 5,
  })]);
  assert.equal(resolved.rawValue, "18250");
  assert.equal(resolved.reportedValue, "18.25");
  assert.equal(resolved.displayValue, "18255");
  assert.equal(resolved.displayUnit, "W");
});

test("uses the latest approved mapping for retained or reconnected evidence from the same identity", () => {
  const retained = { ...parameter, provenance: "retained" as const };
  const [beforeRevision] = applyActiveTelemetryMappings([retained], [mapping({
    displayUnit: "kW",
    scalingMultiplier: 1,
    scalingOffset: 0,
    version: 3,
  })]);
  const [afterRevision] = applyActiveTelemetryMappings([retained], [mapping({
    displayUnit: "W",
    scalingMultiplier: 1_000,
    scalingOffset: 0,
    version: 4,
  })]);

  assert.equal(beforeRevision.displayValue, "18.25");
  assert.equal(afterRevision.displayValue, "18250");
  assert.equal(afterRevision.displayUnit, "W");
  assert.equal(afterRevision.adminMappingVersion, 4);
  assert.equal(afterRevision.provenance, "retained");
});

test("refuses a mapping with a different source identity or device", () => {
  const [wrongSource] = applyActiveTelemetryMappings([parameter], [mapping({ sourceIdentity: "Plant A|Other|vendorpower|40001" })]);
  const [wrongDevice] = applyActiveTelemetryMappings([parameter], [mapping({ deviceId: "INV-02" })]);
  assert.equal(wrongSource.adminMappingDestination, undefined);
  assert.equal(wrongDevice.adminMappingDestination, undefined);
});