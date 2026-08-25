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
  version: number;
};

type TelemetryRow = Record<string, unknown>;

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowSourceName(row: TelemetryRow) {
  return String(row.server_name ?? row.source ?? row.device ?? row.server ?? "MQTT source").trim();
}

function rowAddress(row: TelemetryRow) {
  return String(row.full_addr ?? row.address ?? row.register ?? row.addr ?? "—").trim() || "—";
}

function rowDeviceId(row: TelemetryRow) {
  const value = row.device_id ?? row.deviceId ?? row.inverter_id ?? row.inverterId ?? row.asset_id ?? row.assetId ?? row.server_id ?? row.serverId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Adds only source-map presentation semantics. It never changes the transport
 * raw value, reported value, or any scaling/validation flags, so mapping cannot
 * create a verified engineering KPI.
 */
export function applyTelemetryMappings<T extends TelemetryRow>(rows: T[], mappings: ScadaTelemetryMapping[]) {
  return rows.map((row) => {
    const {
      admin_mapping_id: _mappingId,
      admin_mapping_destination: _mappingDestination,
      admin_mapping_label: _mappingLabel,
      admin_mapping_category: _mappingCategory,
      admin_mapping_version: _mappingVersion,
      admin_mapping_injected_inverter_id: injectedInverter,
      admin_mapping_injected_source_unit: injectedSourceUnit,
      ...withoutMapping
    } = row;
    const baseRow = { ...withoutMapping } as TelemetryRow;
    if (injectedInverter) delete baseRow.inverter_id;
    if (injectedSourceUnit) delete baseRow.reported_unit;

    const name = normalized(baseRow.name ?? baseRow.parameter ?? baseRow.tag);
    const sourceName = rowSourceName(baseRow);
    const address = rowAddress(baseRow);
    const deviceId = rowDeviceId(baseRow);
    const candidates = mappings.filter((mapping) =>
      mapping.sourceName === sourceName
      && mapping.normalizedName === name
      && mapping.address === address
      && (!deviceId || mapping.deviceId === deviceId),
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
    return {
      ...baseRow,
      admin_mapping_id: mapping.id,
      admin_mapping_destination: mapping.destination,
      admin_mapping_label: mapping.displayLabel,
      admin_mapping_category: mapping.category,
      admin_mapping_version: mapping.version,
      ...(shouldInjectInverter ? { inverter_id: mapping.inverterIdentity, admin_mapping_injected_inverter_id: true } : {}),
      ...(shouldInjectSourceUnit ? { reported_unit: mapping.sourceUnit, admin_mapping_injected_source_unit: true } : {}),
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