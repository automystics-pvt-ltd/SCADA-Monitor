import type { PlatformTelemetryMapping } from "@workspace/db";
import type { DeviceParameterCategory, DiscoveredDeviceParameter } from "./device-parameter-discovery";

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

export function applyActiveTelemetryMappings<T extends DiscoveredDeviceParameter>(
  parameters: T[],
  mappings: ActiveMapping[],
): T[] {
  return parameters.map((parameter) => {
    const candidates = mappings.filter((mapping) =>
      mapping.status === "active"
      && mapping.siteName === parameter.siteName
      && mapping.deviceId === parameter.deviceId
      && mapping.sourceIdentity === parameter.sourceIdentity
      && mapping.sourceName === parameter.sourceName
      && mapping.normalizedName === parameter.normalizedName
      && mapping.address === (parameter.address ?? "—"),
    );
    if (candidates.length !== 1) return parameter;

    const mapping = candidates[0]!;
    const multiplier = mapping.scalingMultiplier;
    const offset = mapping.scalingOffset;
    const reported = parameter.reportedNumericValue;
    const transformed = reported === null || !Number.isFinite(reported)
      ? null
      : reported * multiplier + offset;
    const displayNumericValue = transformed !== null && Number.isFinite(transformed) ? transformed : null;
    const validationStatus = reported === null
      ? "not-numeric" as const
      : displayNumericValue === null
        ? "non-finite" as const
        : "valid" as const;
    return {
      ...parameter,
      displayLabel: mapping.displayLabel,
      category: categoryForMapping(mapping.destination, mapping.category, parameter.category),
      value: displayNumericValue ?? parameter.value,
      unit: mapping.displayUnit ?? parameter.unit ?? mapping.sourceUnit,
      sourceUnit: parameter.sourceUnit ?? mapping.sourceUnit,
      displayValue: displayNumericValue === null ? null : formatDisplayValue(displayNumericValue),
      displayNumericValue,
      displayUnit: mapping.displayUnit ?? parameter.sourceUnit ?? mapping.sourceUnit,
      adminMappingDestination: mapping.destination,
      adminMappingLabel: mapping.displayLabel,
      adminMappingCategory: mapping.category,
      adminMappingVersion: mapping.version,
      adminMappingScalingStatus: mapping.scalingStatus,
      adminMappingValidationStatus: validationStatus,
      inverterIdentity: mapping.inverterIdentity,
    } as T;
  });
}