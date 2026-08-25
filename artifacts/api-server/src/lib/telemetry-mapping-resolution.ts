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
  | "version"
  | "status"
>;

/**
 * Mapping is presentation and routing metadata only. It never substitutes a
 * source value, source unit, provenance, or scaling approval.
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
    return {
      ...parameter,
      displayLabel: mapping.displayLabel,
      category: categoryForMapping(mapping.destination, mapping.category, parameter.category),
      unit: parameter.unit ?? mapping.sourceUnit,
      sourceUnit: parameter.sourceUnit ?? mapping.sourceUnit,
      adminMappingDestination: mapping.destination,
      adminMappingLabel: mapping.displayLabel,
      adminMappingCategory: mapping.category,
      adminMappingVersion: mapping.version,
      inverterIdentity: mapping.inverterIdentity,
    } as T;
  });
}