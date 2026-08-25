export type DeviceParameterCategory =
  | "Overview"
  | "Electrical"
  | "Energy"
  | "MPPT / Strings"
  | "Temperature"
  | "Alarms / Faults"
  | "Communication"
  | "Discovered / Other Parameters";

export type DeviceParameterProvenance = "live" | "retained" | "recovered" | "replay" | "snapshot";

import { applyTrn246TelemetryCalibration } from "./trn246-telemetry-calibration";

export type DiscoveredDeviceParameter = {
  observationId: string;
  signalKey: string;
  siteName: string;
  deviceId: string;
  deviceName: string;
  topic: string;
  originalName: string;
  normalizedName: string;
  displayLabel: string;
  category: DeviceParameterCategory;
  rawValue: string;
  reportedValue: string;
  reportedNumericValue: number | null;
  value: number | null;
  unit: string | null;
  sourceUnit: string | null;
  address: string | null;
  sourceName: string;
  sourceIdentity: string;
  sourceMappingStatus: "source-reported" | "raw";
  sourceCounterRole?: "daily-counter" | "cumulative-counter";
  observedAt?: string;
  receivedAt: string;
  provenance: DeviceParameterProvenance;
  dataQuality: "validated" | "raw" | "source-reported";
  scalingStatus: "validated" | "raw";
};

export type DeviceParameterDiscoveryContext = {
  siteName: string;
  topic: string;
  receivedAt: string;
  provenance: DeviceParameterProvenance;
};

export type DeviceParameterFreshness = "live" | "stale" | "saved" | "retained" | "recovered" | "replay";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(source: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => nonEmptyString(source[key])).find(Boolean);
}

function rawText(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function numericValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function displayLabel(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function observationTime(source: Record<string, unknown>) {
  const value = source.date_iso_8601 ?? source.timestamp ?? source.date;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 1_000_000_000_000 ? value * 1_000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
      : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function scalingValidated(source: Record<string, unknown>) {
  return [
    source.scaling_validated,
    source.scalingValidated,
    source.engineering_value_validated,
    source.engineeringValueValidated,
    source.scaling_status,
    source.scalingStatus,
    source.validation_status,
    source.validationStatus,
  ].some((value) => value === true || ["validated", "confirmed", "approved"].includes(String(value).toLowerCase()));
}

function declaredCategory(source: Record<string, unknown>) {
  return String(
    source.measurement_type
    ?? source.measurementType
    ?? source.semantic
    ?? source.metric
    ?? source.kind
    ?? source.category
    ?? "",
  );
}

function signalTokens(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function classifyDeviceParameter(source: Record<string, unknown>, originalName: string): DeviceParameterCategory {
  const declared = signalTokens(declaredCategory(source));
  const names = signalTokens(originalName);
  const tokens = new Set([...declared, ...names]);
  const compact = [...tokens].join("");
  const includesAny = (...expected: string[]) => expected.some((value) => tokens.has(value) || compact === value);
  if (includesAny("alarm", "fault", "trip", "error", "warning")) return "Alarms / Faults";
  if (includesAny("mppt", "tracker", "pvstring", "stringinput", "string")) return "MPPT / Strings";
  if (includesAny("energy", "yield", "generation", "kwh", "mwh", "wh", "dailyenergy", "totalenergy", "lifetimeenergy")) return "Energy";
  if (includesAny("temperature", "temp", "thermal", "heatsink", "cabinet", "cabinettemperature", "heatsinktemperature")) return "Temperature";
  if (includesAny("voltage", "current", "amp", "amps", "amperes", "frequency", "hz", "powerfactor", "reactivepower", "activepower", "acpower", "dcpower", "realpower")) return "Electrical";
  if (includesAny("communication", "connection", "heartbeat", "linkstatus", "networkstatus", "mqttstatus")) return "Communication";
  return "Discovered / Other Parameters";
}

function hash(value: string) {
  let digest = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    digest ^= value.charCodeAt(index);
    digest = Math.imul(digest, 16_777_619);
  }
  return (digest >>> 0).toString(36);
}

const metadataKeys = new Set([
  "name", "parameter", "tag", "registername", "data", "value", "currentvalue", "current_value",
  "customervalue", "customer_value", "reportedvalue", "reported_value", "engineeringvalue", "engineering_value",
  "rawdata", "rawvalue", "raw_value", "dateiso8601", "timestamp", "date", "site", "sitename",
  "site_name", "plant", "plantname", "plant_name", "device", "deviceid", "device_id", "devicename",
  "device_name", "inverter", "inverterid", "inverter_id", "invertername", "inverter_name",
  "assetid", "asset_id", "server", "servername", "server_name", "serverid", "server_id",
  "source", "address", "addr", "fulladdr", "full_addr", "register", "unit", "units", "reportedunit", "reported_unit", "sourceunit", "source_unit",
  "engineeringunit", "engineering_unit", "scalingvalidated", "scaling_validated", "scalingstatus",
  "scaling_status", "measurementtype", "measurement_type", "semantic", "metric", "kind", "category",
]);

function parameterName(source: Record<string, unknown>) {
  return firstText(source, ["name", "parameter", "tag", "registerName", "register_name"]);
}

function parameterValue(source: Record<string, unknown>) {
  for (const key of ["customer_value", "customerValue", "reported_value", "reportedValue", "engineering_value", "engineeringValue", "data", "value", "currentValue", "current_value", "raw_data", "rawValue", "raw_value"]) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function sourceIdentity(source: Record<string, unknown>, context: DeviceParameterDiscoveryContext) {
  const sourceName = firstText(source, ["server_name", "source", "server", "device", "server_id", "serverId"]) ?? "MQTT source";
  const deviceId = firstText(source, ["device_id", "deviceId", "inverter_id", "inverterId", "asset_id", "assetId", "server_id", "serverId"]) ?? `source:${sourceName}`;
  const deviceName = firstText(source, ["device_name", "deviceName", "inverter_name", "inverterName", "device", "server_name", "serverName"]) ?? deviceId;
  return { sourceName, deviceId, deviceName, siteName: context.siteName };
}

function sourceSiteMatchesConfiguredSite(source: Record<string, unknown>, context: DeviceParameterDiscoveryContext) {
  const reportedSite = firstText(source, ["site_name", "siteName", "site", "plant_name", "plantName", "plant", "location"]);
  if (!reportedSite) return true;
  return reportedSite.trim().toLowerCase() === context.siteName.trim().toLowerCase();
}

function buildParameter(
  source: Record<string, unknown>,
  originalName: string,
  rawValue: unknown,
  context: DeviceParameterDiscoveryContext,
): DiscoveredDeviceParameter {
  const mappedSource = applyTrn246TelemetryCalibration(source);
  const identity = sourceIdentity(mappedSource, context);
  const normalizedName = normalized(originalName) || "unnamed";
  const address = firstText(mappedSource, ["full_addr", "address", "register", "addr"]) ?? null;
  const observedAt = observationTime(mappedSource);
  const reported = parameterValue(mappedSource) ?? rawValue;
  const value = numericValue(reported);
  const validated = scalingValidated(mappedSource);
  const sourceMappingStatus = mappedSource.source_mapping_status === "source-reported" ? "source-reported" as const : "raw" as const;
  const signalKey = [identity.siteName, identity.deviceId, normalizedName, address ?? "—"].join("|");
  const sourceIdentityKey = [identity.siteName, identity.sourceName, normalizedName, address ?? "—"].join("|");
  const observationId = `parameter:${hash([sourceIdentityKey, observedAt ?? "", context.receivedAt, rawText(reported), rawText(mappedSource.raw_data ?? mappedSource.rawValue ?? mappedSource.raw_value ?? rawValue)].join("|"))}`;
  return {
    observationId,
    signalKey,
    siteName: identity.siteName,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    topic: context.topic,
    originalName,
    normalizedName,
    displayLabel: firstText(mappedSource, ["display_name", "displayName", "label", "description"]) ?? displayLabel(originalName),
    category: classifyDeviceParameter(mappedSource, originalName),
    rawValue: rawText(mappedSource.raw_data ?? mappedSource.rawValue ?? mappedSource.raw_value ?? rawValue),
    reportedValue: rawText(reported),
    reportedNumericValue: value,
    value,
    unit: firstText(mappedSource, ["engineering_unit", "engineeringUnit", "unit", "units"]) ?? null,
    sourceUnit: firstText(mappedSource, ["reported_unit", "reportedUnit", "customer_unit", "customerUnit", "source_unit", "sourceUnit", "engineering_unit", "engineeringUnit", "unit", "units"]) ?? null,
    address,
    sourceName: identity.sourceName,
    sourceIdentity: sourceIdentityKey,
    sourceMappingStatus,
    sourceCounterRole: mappedSource.source_counter_role === "daily-counter" || mappedSource.source_counter_role === "cumulative-counter" ? mappedSource.source_counter_role : undefined,
    observedAt,
    receivedAt: context.receivedAt,
    provenance: context.provenance,
    dataQuality: validated ? "validated" : sourceMappingStatus === "source-reported" || value === null ? "source-reported" : "raw",
    scalingStatus: validated ? "validated" : "raw",
  };
}

/**
 * Walks compatible MQTT/Modbus payloads without inventing a semantic mapping.
 * Named register objects stay intact; unnamed nested leaves become traceable
 * "Discovered / Other Parameters" evidence unless source metadata says more.
 */
export function discoverDeviceParameters(payload: unknown, context: DeviceParameterDiscoveryContext) {
  const observations: DiscoveredDeviceParameter[] = [];
  const seen = new Set<string>();
  const append = (source: Record<string, unknown>, name: string, value: unknown) => {
    if (!sourceSiteMatchesConfiguredSite(source, context)) return;
    const observation = buildParameter(source, name, value, context);
    if (seen.has(observation.observationId)) return;
    seen.add(observation.observationId);
    observations.push(observation);
  };
  const walk = (value: unknown, inherited: Record<string, unknown>, path: string[], depth: number): void => {
    if (depth > 8 || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, inherited, [...path, `[${index}]`], depth + 1));
      return;
    }
    if (!isRecord(value)) {
      if (path.length) append(inherited, path.join("."), value);
      return;
    }
    const merged = { ...inherited, ...value };
    const named = parameterName(value);
    const namedValue = parameterValue(value);
    if (named && namedValue !== undefined) {
      append(merged, named, namedValue);
      if (isRecord(namedValue) || Array.isArray(namedValue)) {
        walk(namedValue, merged, [...path, named], depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (metadataKeys.has(normalized(key))) {
        if (isRecord(child) || Array.isArray(child)) walk(child, merged, [...path, key], depth + 1);
        continue;
      }
      walk(child, merged, [...path, key], depth + 1);
    }
  };
  const root = isRecord(payload) && isRecord(payload.Automystics) ? payload.Automystics : payload;
  walk(root, isRecord(root) ? root : {}, [], 0);
  return observations;
}

export function discoverDeviceParametersFromRawPayload(rawPayload: string, context: DeviceParameterDiscoveryContext) {
  try {
    return discoverDeviceParameters(JSON.parse(rawPayload), context);
  } catch {
    return [];
  }
}

export function latestDeviceParameterWins(current: DiscoveredDeviceParameter | undefined, candidate: DiscoveredDeviceParameter) {
  if (!current) return true;
  const rank = (value: DiscoveredDeviceParameter["provenance"]) => value === "live" ? 4 : value === "recovered" ? 3 : value === "retained" ? 2 : value === "replay" ? 1 : 0;
  if (rank(candidate.provenance) !== rank(current.provenance)) return rank(candidate.provenance) > rank(current.provenance);
  const candidateTime = Date.parse(candidate.receivedAt);
  const currentTime = Date.parse(current.receivedAt);
  return Number.isFinite(candidateTime) && (!Number.isFinite(currentTime) || candidateTime >= currentTime);
}

export function deviceParameterFreshness(parameter: DiscoveredDeviceParameter, now = Date.now()): { ageMs?: number; freshness: DeviceParameterFreshness } {
  if (parameter.provenance === "snapshot") return { freshness: "saved" };
  if (parameter.provenance !== "live") return { freshness: parameter.provenance };
  const observedAt = parameter.observedAt ? Date.parse(parameter.observedAt) : NaN;
  if (!Number.isFinite(observedAt)) return { freshness: "stale" };
  const ageMs = now - observedAt;
  return { ageMs, freshness: ageMs >= 0 && ageMs <= 30_000 ? "live" : "stale" };
}