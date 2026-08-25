import type { PlatformTelemetryMapping } from "@workspace/db";
import type { DeviceParameterCategory, DiscoveredDeviceParameter } from "./device-parameter-discovery";
import { telemetryMappingRequiresDisplayUnit } from "./telemetry-mapping-policy";

type ActiveMapping = Pick<
  PlatformTelemetryMapping,
  | "id"
  | "siteName"
  | "deviceId"
  | "sourceIdentity"
  | "sourceName"
  | "normalizedName"
  | "address"
  | "destination"
  | "displayLabel"
  | "category"
  | "inverterIdentity"
  | "sourceUnit"
  | "displayUnit"
  | "scalingMultiplier"
  | "scalingOffset"
  | "scalingStatus"
  | "version"
  | "status"
>;

/**
 * Mapping resolves a separately labeled customer-facing display value. It
 * never replaces raw transport or source-reported evidence, and it does not
 * approve derived plant KPIs or energy calculations.
 */
const categories = new Set<DeviceParameterCategory>([
  "Overview",
  "Electrical",
  "Energy",
  "MPPT / Strings",
  "Temperature",
  "Alarms / Faults",
  "Communication",
  "Discovered / Other Parameters",
]);

function categoryForMapping(
  destination: ActiveMapping["destination"],
  requestedCategory: string,
  fallback: DeviceParameterCategory,
) {
  if (categories.has(requestedCategory as DeviceParameterCategory)) return requestedCategory as DeviceParameterCategory;
  if (["active-power", "voltage", "current", "frequency"].includes(destination)) return "Electrical";
  if (["daily-energy", "total-energy", "specific-yield"].includes(destination)) return "Energy";
  if (["alarm", "fault"].includes(destination)) return "Alarms / Faults";
  if (destination === "communication") return "Communication";
  if (destination === "environmental") return "Overview";
  return fallback;
}

function formatDisplayValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
}

function mappingIdentityKey(identity: Pick<ActiveMapping, "siteName" | "deviceId" | "sourceIdentity" | "normalizedName" | "address">) {
  return [identity.siteName, identity.deviceId, identity.sourceIdentity, identity.normalizedName, identity.address].join("\u001f");
}

/**
 * A saved snapshot or retained row may carry an older mapping projection.
 * Remove that projection before resolving the active source of truth so a clear
 * or revision cannot leave retired presentation fields behind.
 */
function stripMappingProjection<T extends DiscoveredDeviceParameter>(parameter: T): T {
  const record = parameter as T & Record<string, unknown>;
  const hadProjection = record.adminMappingId !== undefined
    || record.adminMappingDestination !== undefined
    || record.adminMappingVersion !== undefined;
  if (!hadProjection) return parameter;
  const base = { ...record };
  delete base.adminMappingId;
  delete base.adminMappingDestination;
  delete base.adminMappingLabel;
  delete base.adminMappingCategory;
  delete base.adminMappingVersion;
  delete base.adminMappingScalingStatus;
  delete base.adminMappingValidationStatus;
  const injectedInverterIdentity = Boolean(base.adminMappingInjectedInverterIdentity);
  delete base.adminMappingInjectedInverterIdentity;
  if (injectedInverterIdentity) delete base.inverterIdentity;
  return {
    ...base,
    displayLabel: parameter.originalName || parameter.displayLabel,
    category: "Discovered / Other Parameters",
    value: parameter.reportedNumericValue,
    unit: parameter.sourceUnit ?? null,
    displayValue: null,
    displayNumericValue: null,
    displayUnit: null,
    mappingLifecycleStatus: "unmapped",
  } as T;
}

export function applyActiveTelemetryMappings<T extends DiscoveredDeviceParameter>(
  parameters: T[],
  mappings: ActiveMapping[],
): T[] {
  const mappingsByIdentity = new Map(
    mappings
      .filter((mapping) => mapping.status === "active")
      .map((mapping) => [mappingIdentityKey(mapping), mapping]),
  );
  return parameters.map((parameter) => {
    const base = stripMappingProjection(parameter);
    const mapping = mappingsByIdentity.get(mappingIdentityKey({
      siteName: base.siteName,
      deviceId: base.deviceId,
      sourceIdentity: base.sourceIdentity,
      normalizedName: base.normalizedName,
      address: base.address ?? "—",
    }));
    if (!mapping || mapping.sourceName !== base.sourceName) return base;
    const multiplier = mapping.scalingMultiplier;
    const offset = mapping.scalingOffset;
    const reported = base.reportedNumericValue;
    const canDisplayEngineeringValue = telemetryMappingRequiresDisplayUnit(mapping.destination);
    const transformed = !canDisplayEngineeringValue || reported === null || !Number.isFinite(reported)
      ? null
      : reported * multiplier + offset;
    const displayNumericValue = transformed !== null && Number.isFinite(transformed) ? transformed : null;
    const validationStatus = !canDisplayEngineeringValue
      ? null
      : reported === null
        ? "not-numeric" as const
        : displayNumericValue === null
        ? "non-finite" as const
        : "valid" as const;
    return {
      ...base,
      displayLabel: mapping.displayLabel,
      category: categoryForMapping(mapping.destination, mapping.category, base.category),
      value: displayNumericValue ?? base.value,
      unit: mapping.displayUnit ?? base.unit ?? mapping.sourceUnit,
      sourceUnit: base.sourceUnit ?? mapping.sourceUnit,
      displayValue: displayNumericValue === null ? null : formatDisplayValue(displayNumericValue),
      displayNumericValue,
      displayUnit: mapping.displayUnit ?? base.sourceUnit ?? mapping.sourceUnit,
      adminMappingId: mapping.id,
      adminMappingDestination: mapping.destination,
      adminMappingLabel: mapping.displayLabel,
      adminMappingCategory: mapping.category,
      adminMappingVersion: mapping.version,
      adminMappingScalingStatus: mapping.scalingStatus,
      adminMappingValidationStatus: validationStatus,
      inverterIdentity: mapping.inverterIdentity,
      adminMappingInjectedInverterIdentity: Boolean(mapping.inverterIdentity),
      mappingLifecycleStatus: "mapped",
    } as T;
  });
}