export type ScadaTelemetryMapping = {
  id: string;
  deviceId: string;
  sourceIdentity: string;
  sourceName: string;
  normalizedName: string;
  address: string;
  destination: string;
  displayLabel: string;
  category: string;
  inverterIdentity: string | null;
  sourceUnit: string | null;
  displayUnit?: string | null;
  scalingMultiplier?: number;
  scalingOffset?: number;
  scalingStatus?: string;
  version: number;
};

type TelemetryRow = Record<string, unknown>;
const unitlessDestinations = new Set(["inverter-identity", "alarm", "fault", "communication", "data-quality"]);

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowSourceName(row: TelemetryRow) {
  return String(row.server_name ?? row.sourceName ?? row.source ?? row.device ?? row.server ?? "MQTT source").trim();
}

function rowAddress(row: TelemetryRow) {
  return String(row.full_addr ?? row.address ?? row.register ?? row.addr ?? "—").trim() || "—";
}

function rowDeviceId(row: TelemetryRow) {
  const value = row.device_id ?? row.deviceId ?? row.inverter_id ?? row.inverterId ?? row.asset_id ?? row.assetId ?? row.server_id ?? row.serverId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rowSourceIdentity(row: TelemetryRow) {
  const value = row.source_identity ?? row.sourceIdentity;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceReportedNumber(row: TelemetryRow) {
  const sourceMappingStatus = row.source_mapping_status ?? row.sourceMappingStatus;
  if (sourceMappingStatus !== undefined && sourceMappingStatus !== null && sourceMappingStatus !== "" && sourceMappingStatus !== "source-reported") return null;
  const value = row.reported_value ?? row.reportedValue ?? row.customer_value ?? row.customerValue ?? row.engineering_value ?? row.engineeringValue;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function mappedTelemetryDisplayLabel(row: TelemetryRow) {
  const label = row.admin_mapping_label ?? row.adminMappingLabel ?? row.displayLabel;
  return typeof label === "string" && label.trim()
    ? label.trim()
    : String(row.name ?? row.parameter ?? row.tag ?? row.normalizedName ?? "—");
}

export function mappedTelemetryDestination(row: TelemetryRow) {
  const destination = row.admin_mapping_destination ?? row.adminMappingDestination;
  return typeof destination === "string" && destination.trim() ? destination.trim() : null;
}

/**
 * Adds only source-map presentation semantics. It never changes the transport
 * raw value or reported value. It may reproduce a server-approved customer
 * display value only from explicit source-reported evidence.
 */
export function applyTelemetryMappings<T extends TelemetryRow>(rows: T[], mappings: ScadaTelemetryMapping[]) {
  return rows.map((row) => {
    const {
      admin_mapping_id: _mappingId,
      admin_mapping_destination: _mappingDestination,
      admin_mapping_label: _mappingLabel,
      admin_mapping_category: _mappingCategory,
      admin_mapping_version: _mappingVersion,
      admin_mapping_scaling_status: _mappingScalingStatus,
      admin_mapping_validation_status: _mappingValidationStatus,
      admin_mapping_injected_inverter_id: injectedInverter,
      admin_mapping_injected_source_unit: injectedSourceUnit,
      admin_mapping_injected_display_value: injectedDisplayValue,
      admin_mapping_injected_display_unit: injectedDisplayUnit,
      ...withoutMapping
    } = row;
    const baseRow = { ...withoutMapping } as TelemetryRow;
    const hadSavedMapping = Boolean(_mappingId || _mappingDestination);
    if (injectedInverter) delete baseRow.inverter_id;
    if (injectedSourceUnit) delete baseRow.reported_unit;
    if (injectedDisplayValue || hadSavedMapping) {
      delete baseRow.display_value;
      delete baseRow.displayValue;
    }
    if (injectedDisplayUnit || hadSavedMapping) {
      delete baseRow.display_unit;
      delete baseRow.displayUnit;
    }

    const name = normalized(baseRow.name ?? baseRow.parameter ?? baseRow.tag ?? baseRow.normalizedName ?? baseRow.originalName);
    const sourceName = rowSourceName(baseRow);
    const address = rowAddress(baseRow);
    const deviceId = rowDeviceId(baseRow);
    const sourceIdentity = rowSourceIdentity(baseRow);
    const candidates = mappings.filter((mapping) =>
      mapping.sourceName === sourceName
      && mapping.normalizedName === name
      && mapping.address === address
      && (!deviceId || mapping.deviceId === deviceId)
      && (!sourceIdentity || mapping.sourceIdentity === sourceIdentity),
    );
    // A source payload may omit a device ID. Only apply when the remaining
    // source/register identity resolves to exactly one managed mapping.
    if (candidates.length !== 1) return baseRow as T;
    const mapping = candidates[0]!;
    const shouldInjectInverter = Boolean(mapping.inverterIdentity);
    const shouldInjectSourceUnit = !(
      baseRow.reported_unit
      ?? baseRow.reportedUnit
      ?? baseRow.source_unit
      ?? baseRow.sourceUnit
      ?? baseRow.customer_unit
      ?? baseRow.customerUnit
    ) && Boolean(mapping.sourceUnit);
    const reported = sourceReportedNumber(baseRow);
    const multiplier = mapping.scalingMultiplier ?? 1;
    const offset = mapping.scalingOffset ?? 0;
    const canResolveDisplayValue = !unitlessDestinations.has(mapping.destination)
      && mapping.scalingStatus === "approved"
      && Boolean(mapping.displayUnit)
      && reported !== null
      && Number.isFinite(multiplier)
      && Number.isFinite(offset);
    const displayValue = canResolveDisplayValue ? reported * multiplier + offset : null;
    const hasFiniteDisplayValue = displayValue !== null && Number.isFinite(displayValue);
    return {
      ...baseRow,
      admin_mapping_id: mapping.id,
      admin_mapping_destination: mapping.destination,
      admin_mapping_label: mapping.displayLabel,
      admin_mapping_category: mapping.category,
      admin_mapping_version: mapping.version,
      ...(shouldInjectInverter ? { inverter_id: mapping.inverterIdentity, admin_mapping_injected_inverter_id: true } : {}),
      ...(shouldInjectSourceUnit ? { reported_unit: mapping.sourceUnit, admin_mapping_injected_source_unit: true } : {}),
      ...(hasFiniteDisplayValue ? {
        display_value: displayValue,
        display_unit: mapping.displayUnit,
        admin_mapping_scaling_status: "approved",
        admin_mapping_validation_status: "valid",
        admin_mapping_injected_display_value: true,
        admin_mapping_injected_display_unit: true,
      } : {}),
    } as unknown as T;
  });
}

/**
 * The SSE connection is long-lived, so ingestion must read the newest mapping
 * set at message time rather than close over a render-time mapping array.
 */
export function createTelemetryMappingStore() {
  let currentMappings: ScadaTelemetryMapping[] = [];
  return {
    setMappings(mappings: ScadaTelemetryMapping[]) {
      currentMappings = mappings;
    },
    apply<T extends TelemetryRow>(rows: T[]) {
      return applyTelemetryMappings(rows, currentMappings);
    },
  };
}