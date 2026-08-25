import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformTelemetryMapping } from "@workspace/db";
import type { DiscoveredDeviceParameter } from "./device-parameter-discovery";
import { mappingWorkspaceRows } from "./telemetry-mapping-workspace";

const mapping: PlatformTelemetryMapping = {
  id: "map-1",
  siteName: "Sambavi",
  deviceId: "source:ana",
  sourceIdentity: "Sambavi|ana|actpow|305031",
  sourceName: "ana",
  normalizedName: "actpow",
  address: "305031",
  destination: "active-power",
  displayLabel: "AC active power",
  category: "Electrical",
  inverterIdentity: "inv1",
  sourceUnit: "kW",
  displayUnit: "kW",
  scalingMultiplier: 1,
  scalingOffset: 0,
  scalingStatus: "approved",
  status: "active",
  version: 2,
  createdBy: "admin-1",
  updatedBy: "admin-1",
  clearedAt: null,
  createdAt: new Date("2026-08-25T09:00:00.000Z"),
  updatedAt: new Date("2026-08-25T09:10:00.000Z"),
};

const parameter: DiscoveredDeviceParameter & { freshness: "saved" } = {
  observationId: "catalog:1",
  signalKey: "Sambavi|source:ana|actpow|305031",
  siteName: "Sambavi",
  deviceId: "source:ana",
  deviceName: "ana",
  topic: "trn246/modbus",
  originalName: "actpow",
  normalizedName: "actpow",
  displayLabel: "AC active power",
  category: "Electrical",
  rawValue: "3200",
  reportedValue: "3.2",
  reportedNumericValue: 3.2,
  value: 3.2,
  unit: "kW",
  sourceUnit: "kW",
  address: "305031",
  sourceName: "ana",
  sourceIdentity: "Sambavi|ana|actpow|305031",
  sourceMappingStatus: "source-reported",
  receivedAt: "2026-08-25T09:15:00.000Z",
  provenance: "snapshot",
  dataQuality: "source-reported",
  scalingStatus: "raw",
  freshness: "saved",
};

test("retains a saved mapping as an editable configuration row without current evidence", () => {
  const [row] = mappingWorkspaceRows([], [mapping]);
  assert.equal(row.parameter.evidenceAvailable, false);
  assert.equal(row.parameter.reportedValue, null);
  assert.equal(row.parameter.provenance, "configuration");
  assert.equal(row.parameter.freshness, "saved");
  assert.equal(row.mapping?.id, mapping.id);
});

test("attaches a saved mapping to current evidence without duplicating the parameter", () => {
  const rows = mappingWorkspaceRows([parameter], [mapping]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.parameter.evidenceAvailable, true);
  assert.equal(rows[0]?.parameter.reportedValue, "3.2");
  assert.equal(rows[0]?.mapping?.version, 2);
});

test("keeps an updated saved mapping revision available after evidence reload", () => {
  const revised = {
    ...mapping,
    displayLabel: "Edited AC power",
    scalingMultiplier: 0.001,
    version: 3,
  };
  const [row] = mappingWorkspaceRows([], [revised]);
  assert.equal(row?.mapping?.displayLabel, "Edited AC power");
  assert.equal(row?.mapping?.scalingMultiplier, 0.001);
  assert.equal(row?.mapping?.version, 3);
});

test("does not apply a saved mapping across sources sharing a device and register", () => {
  const secondParameter = {
    ...parameter,
    observationId: "catalog:2",
    signalKey: "Sambavi|source:ana|Sambavi|other|actpow|305031|actpow|305031",
    sourceName: "other",
    sourceIdentity: "Sambavi|other|actpow|305031",
  };
  const otherDeviceMapping = {
    ...mapping,
    id: "map-2",
    sourceName: "other",
    sourceIdentity: "Sambavi|other|actpow|305031",
  };
  const rows = mappingWorkspaceRows([parameter, secondParameter], [mapping, otherDeviceMapping]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.parameter.sourceIdentity === parameter.sourceIdentity)?.mapping?.id, "map-1");
  assert.equal(rows.find((row) => row.parameter.sourceIdentity === secondParameter.sourceIdentity)?.mapping?.id, "map-2");
});

test("removes cleared mappings from the workspace while retaining source evidence", () => {
  const [row] = mappingWorkspaceRows([parameter], []);
  assert.equal(row?.parameter.evidenceAvailable, true);
  assert.equal(row?.mapping, null);
});