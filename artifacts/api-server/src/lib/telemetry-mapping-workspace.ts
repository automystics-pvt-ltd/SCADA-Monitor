import type { PlatformTelemetryMapping } from "@workspace/db";
import type { DeviceParameterFreshness, DiscoveredDeviceParameter } from "./device-parameter-discovery";

export type MappingWorkspaceParameter = Omit<
  DiscoveredDeviceParameter,
  "rawValue" | "reportedValue" | "receivedAt" | "provenance"
> & {
  evidenceAvailable: boolean;
  rawValue: string | null;
  reportedValue: string | null;
  receivedAt: string | null;
  provenance: DiscoveredDeviceParameter["provenance"] | "configuration";
  freshness: DeviceParameterFreshness;
};

export type MappingWorkspaceRow = {
  parameter: MappingWorkspaceParameter;
  mapping: PlatformTelemetryMapping | null;
};

export function telemetryMappingIdentityKey(identity: {
  siteName: string;
  deviceId: string;
  sourceIdentity: string;
  normalizedName: string;
  address: string;
}) {
  return [
    identity.siteName,
    identity.deviceId,
    identity.sourceIdentity,
    identity.normalizedName,
    identity.address,
  ].join("\u001f");
}

function savedMappingParameter(mapping: PlatformTelemetryMapping): MappingWorkspaceParameter {
  return {
    observationId: `mapping:${mapping.id}`,
    signalKey: [mapping.siteName, mapping.deviceId, mapping.sourceIdentity, mapping.normalizedName, mapping.address].join("|"),
    siteName: mapping.siteName,
    deviceId: mapping.deviceId,
    deviceName: mapping.deviceId,
    topic: "",
    originalName: mapping.displayLabel,
    normalizedName: mapping.normalizedName,
    displayLabel: mapping.displayLabel,
    category: mapping.category as DiscoveredDeviceParameter["category"],
    evidenceAvailable: false,
    rawValue: null,
    reportedValue: null,
    reportedNumericValue: null,
    displayValue: null,
    displayNumericValue: null,
    displayUnit: mapping.displayUnit,
    value: null,
    unit: mapping.displayUnit ?? mapping.sourceUnit,
    sourceUnit: mapping.sourceUnit,
    address: mapping.address === "—" ? null : mapping.address,
    sourceName: mapping.sourceName,
    sourceIdentity: mapping.sourceIdentity,
    sourceMappingStatus: "raw",
    observedAt: undefined,
    receivedAt: null,
    provenance: "configuration",
    dataQuality: "raw",
    scalingStatus: "raw",
    adminMappingDestination: mapping.destination,
    adminMappingLabel: mapping.displayLabel,
    adminMappingCategory: mapping.category,
    adminMappingVersion: mapping.version,
    adminMappingScalingStatus: mapping.scalingStatus,
    inverterIdentity: mapping.inverterIdentity,
    freshness: "saved",
  };
}

/**
 * Keeps saved mappings visible and editable even when a device has not sent a
 * fresh packet. Configuration-only rows deliberately carry no telemetry value.
 */
export function mappingWorkspaceRows(
  parameters: Array<DiscoveredDeviceParameter & { freshness: DeviceParameterFreshness }>,
  mappings: PlatformTelemetryMapping[],
): MappingWorkspaceRow[] {
  const mappingByIdentity = new Map(
    mappings.map((mapping) => [telemetryMappingIdentityKey(mapping), mapping]),
  );
  const rows: MappingWorkspaceRow[] = parameters.map((parameter) => ({
    parameter: {
      ...parameter,
      evidenceAvailable: true,
    },
    mapping: mappingByIdentity.get(telemetryMappingIdentityKey({
      siteName: parameter.siteName,
      deviceId: parameter.deviceId,
      sourceIdentity: parameter.sourceIdentity,
      normalizedName: parameter.normalizedName,
      address: parameter.address ?? "—",
    })) ?? null,
  }));
  const evidenceIdentities = new Set(rows.map(({ parameter }) => telemetryMappingIdentityKey({
    siteName: parameter.siteName,
    deviceId: parameter.deviceId,
    sourceIdentity: parameter.sourceIdentity,
    normalizedName: parameter.normalizedName,
    address: parameter.address ?? "—",
  })));

  for (const mapping of mappings) {
    if (evidenceIdentities.has(telemetryMappingIdentityKey(mapping))) continue;
    rows.push({ parameter: savedMappingParameter(mapping), mapping });
  }

  return rows.sort((left, right) => {
    const leftSaved = left.parameter.evidenceAvailable ? 0 : 1;
    const rightSaved = right.parameter.evidenceAvailable ? 0 : 1;
    return leftSaved - rightSaved || left.parameter.displayLabel.localeCompare(right.parameter.displayLabel);
  });
}