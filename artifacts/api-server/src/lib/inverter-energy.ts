export type InverterEnergyObservation = {
  siteName: string;
  inverterId: string;
  inverterName: string;
  parameter: string;
  value: number;
  rawValue: string;
  unit: string;
  address: string;
  sourceName: string;
  observedAt: string;
  scalingStatus: "validated" | "raw";
  metadata: Record<string, unknown>;
};

export type InverterActivePowerObservation = {
  siteName: string;
  inverterId: string;
  inverterName: string;
  parameter: string;
  value: number;
  rawValue: string;
  unit: "kW";
  activePowerSemantic: "active-power";
  scalingStatus: "validated";
  address: string;
  sourceName: string;
  observedAt: string;
  metadata: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function explicitScalingValidated(parameter: Record<string, unknown>) {
  const values = [
    parameter.scaling_validated,
    parameter.scalingValidated,
    parameter.engineering_value_validated,
    parameter.engineeringValueValidated,
    parameter.scaling_status,
    parameter.scalingStatus,
    parameter.validation_status,
    parameter.validationStatus,
  ];
  return values.some((value) => value === true || ["validated", "confirmed", "approved"].includes(String(value).toLowerCase()));
}

function observationTime(parameter: Record<string, unknown>) {
  const value = parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date;
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 1_000_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric)
      ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
      : new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

function inverterIdentity(parameter: Record<string, unknown>, parameterName: string) {
  const explicit = [
    parameter.inverter_id,
    parameter.inverterId,
    parameter.inverter,
    parameter.device_id,
    parameter.deviceId,
  ].map(stringValue).find(Boolean);
  if (explicit) return explicit;

  const compactName = normalized(parameterName);
  const match = compactName.match(/^(?:inverter|inv)(\d+)(?:energy|kwh|daily|today|total)?$/);
  return match ? `inv${match[1]}` : undefined;
}

function explicitInverterIdentity(parameter: Record<string, unknown>) {
  return [
    parameter.inverter_id,
    parameter.inverterId,
    parameter.device_id,
    parameter.deviceId,
    parameter.asset_id,
    parameter.assetId,
  ].map(stringValue).find(Boolean);
}

function activePowerSemantic(parameter: Record<string, unknown>) {
  const declared = normalized(String(
    parameter.measurement_type
    ?? parameter.measurementType
    ?? parameter.semantic
    ?? parameter.metric
    ?? parameter.kind
    ?? parameter.engineering_semantic
    ?? parameter.engineeringSemantic
    ?? "",
  ));
  return ["activepower", "acpower", "realpower"].includes(declared) ? "active-power" as const : undefined;
}

function activePowerUnit(parameter: Record<string, unknown>) {
  const sourceUnit = stringValue(parameter.engineering_unit)
    ?? stringValue(parameter.engineeringUnit)
    ?? stringValue(parameter.unit)
    ?? stringValue(parameter.units);
  if (!sourceUnit) return undefined;
  const unit = normalized(sourceUnit);
  if (["w", "watt", "watts"].includes(unit)) return { sourceUnit, multiplier: 1 / 1_000 };
  if (["kw", "kilowatt", "kilowatts"].includes(unit)) return { sourceUnit, multiplier: 1 };
  if (["mw", "megawatt", "megawatts"].includes(unit)) return { sourceUnit, multiplier: 1_000 };
  return undefined;
}

function isInverterEnergyName(parameterName: string) {
  const compactName = normalized(parameterName);
  return /^(?:inverter|inv)\d+(?:energy|kwh|daily|today|total)?$/.test(compactName)
    || /^(?:energy|yield)(?:inverter|inv)\d+$/.test(compactName);
}

function siteNameFrom(parameter: Record<string, unknown>) {
  return [
    parameter.site_name,
    parameter.siteName,
    parameter.site,
    parameter.plant_name,
    parameter.plantName,
    parameter.plant,
    parameter.location,
  ].map(stringValue).find(Boolean);
}

function isTrustedBareInverterYield(parameter: Record<string, unknown>, parameterName: string) {
  const sourceName = String(parameter.server_name ?? parameter.source ?? "").trim().toLowerCase();
  const address = String(parameter.full_addr ?? parameter.address ?? parameter.register ?? parameter.addr ?? "").trim();
  return /^inv\d+$/i.test(parameterName) && sourceName === "ana" && address === "305003";
}

export function inverterEnergyObservationFromParameter(parameter: Record<string, unknown>, siteName: string): InverterEnergyObservation | undefined {
  const parameterName = stringValue(parameter.name) ?? stringValue(parameter.parameter) ?? stringValue(parameter.tag);
  if (!parameterName) return undefined;

  const inverterId = inverterIdentity(parameter, parameterName);
  const semanticEnergyName = isInverterEnergyName(parameterName);
  const explicitEnergyUnit = stringValue(parameter.energy_unit) ?? stringValue(parameter.energyUnit);
  const trustedBareInverterYield = isTrustedBareInverterYield(parameter, parameterName);
  if (!inverterId || (!trustedBareInverterYield && !semanticEnergyName) || (!trustedBareInverterYield && !explicitEnergyUnit && !explicitScalingValidated(parameter))) return undefined;
  const sourceSite = siteNameFrom(parameter);
  if (sourceSite && sourceSite !== siteName) return undefined;

  const value = numericValue(parameter.data ?? parameter.value ?? parameter.currentValue ?? parameter.current_value);
  const observedAt = observationTime(parameter);
  if (value === undefined || !observedAt) return undefined;

  const unit = stringValue(parameter.unit)
    ?? explicitEnergyUnit
    ?? (normalized(parameterName).includes("kwh") ? "kWh" : "source units");
  const rawValue = String(parameter.raw_data ?? parameter.rawValue ?? parameter.raw_value ?? parameter.data ?? parameter.value ?? "");
  const address = String(parameter.full_addr ?? parameter.address ?? parameter.register ?? parameter.addr ?? "—");
  const sourceName = String(parameter.server_name ?? parameter.source ?? parameter.device ?? parameter.server ?? "MQTT source");
  const inverterName = stringValue(parameter.inverter_name)
    ?? stringValue(parameter.inverterName)
    ?? (inverterId.match(/^inv(\d+)$/i)?.[1] ? `Inverter ${inverterId.match(/^inv(\d+)$/i)![1].padStart(2, "0")}` : inverterId);

  return {
    siteName,
    inverterId,
    inverterName,
    parameter: parameterName,
    value,
    rawValue,
    unit,
    address,
    sourceName,
    observedAt,
    scalingStatus: explicitScalingValidated(parameter) ? "validated" : "raw",
    metadata: {
      serverId: parameter.server_id ?? parameter.serverId,
      sourceTimestamp: parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date,
      sourceMapping: trustedBareInverterYield ? "ana/305003/invN" : "explicit-inverter-energy",
    },
  };
}

/**
 * Returns an operationally usable inverter active-power record only when the
 * source makes every safety-critical part of the mapping explicit. Bare invN
 * register names are intentionally not enough to create a live fleet asset.
 */
export function inverterActivePowerObservationFromParameter(parameter: Record<string, unknown>, siteName: string): InverterActivePowerObservation | undefined {
  const parameterName = stringValue(parameter.name) ?? stringValue(parameter.parameter) ?? stringValue(parameter.tag);
  const inverterId = explicitInverterIdentity(parameter);
  const semantic = activePowerSemantic(parameter);
  const unit = activePowerUnit(parameter);
  const sourceSite = siteNameFrom(parameter);
  if (!parameterName || !inverterId || !semantic || !unit || !explicitScalingValidated(parameter)) return undefined;
  if (sourceSite && sourceSite !== siteName) return undefined;

  const rawValue = numericValue(parameter.data ?? parameter.value ?? parameter.currentValue ?? parameter.current_value);
  const observedAt = observationTime(parameter);
  if (rawValue === undefined || !observedAt) return undefined;
  if (Date.parse(observedAt) > Date.now()) return undefined;

  const address = String(parameter.full_addr ?? parameter.address ?? parameter.register ?? parameter.addr ?? "—");
  const sourceName = String(parameter.server_name ?? parameter.source ?? parameter.device ?? parameter.server ?? "MQTT source");
  const inverterName = stringValue(parameter.inverter_name)
    ?? stringValue(parameter.inverterName)
    ?? inverterId;

  return {
    siteName,
    inverterId,
    inverterName,
    parameter: parameterName,
    value: rawValue * unit.multiplier,
    rawValue: String(parameter.raw_data ?? parameter.rawValue ?? parameter.raw_value ?? parameter.data ?? parameter.value ?? ""),
    unit: "kW",
    activePowerSemantic: semantic,
    scalingStatus: "validated",
    address,
    sourceName,
    observedAt,
    metadata: {
      sourceUnit: unit.sourceUnit,
      serverId: parameter.server_id ?? parameter.serverId,
      sourceTimestamp: parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date,
      sourceMapping: "explicit-inverter-identity-active-power",
    },
  };
}