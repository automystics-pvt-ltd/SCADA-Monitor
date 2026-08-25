import type { RawTelemetryMetric, TelemetryKpiRow } from "./telemetry-kpis.ts";

export type LiveEnergySample = {
  id: string;
  seriesKey: string;
  parameter: string;
  address: string;
  sourceName: string;
  value: number;
  sourceObservedAt?: string;
  receivedAt: string;
};

const DAILY_ENERGY_PARAMETERS = new Set([
  "dailyenergy",
  "dailyenergykwh",
  "dailyeneregykwh",
  "todayenergy",
  "todayenergykwh",
]);

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isoTimestamp(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  const parsed = Number.isFinite(numeric)
    ? numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
    : new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function isDailyEnergyRow(row: TelemetryKpiRow) {
  const name = normalized(row.name ?? row.parameter ?? row.tag);
  if (DAILY_ENERGY_PARAMETERS.has(name)) return true;
  const declared = normalized(row.admin_mapping_destination ?? row.adminMappingDestination ?? row.measurement_type ?? row.measurementType ?? row.semantic ?? row.metric ?? row.kind);
  return ["dailyenergy", "dailyenergycounter"].includes(declared);
}

/**
 * Convert direct MQTT/SSE rows into plotting evidence. This intentionally
 * retains exact source values and never estimates energy from power samples.
 */
export function liveEnergySamplesFromRows(rows: TelemetryKpiRow[], receivedAt: string) {
  const serverReceivedAt = isoTimestamp(receivedAt) ?? new Date().toISOString();
  return rows.flatMap((row): LiveEnergySample[] => {
    if (!isDailyEnergyRow(row)) return [];
    const value = numeric(row.data ?? row.value ?? row.currentValue ?? row.current_value);
    if (value === undefined) return [];
    const parameter = String(row.name ?? row.parameter ?? row.tag ?? "daily-energy");
    const address = String(row.full_addr ?? row.address ?? row.register ?? row.addr ?? "—");
    const sourceName = String(row.server_name ?? row.source ?? row.device ?? row.server ?? "MQTT source");
    const sourceObservedAt = isoTimestamp(row.date_iso_8601 ?? row.timestamp ?? row.date);
    const seriesKey = `${sourceName}|${parameter}|${address}`;
    return [{
      id: `${seriesKey}|${sourceObservedAt ?? serverReceivedAt}|${value}`,
      seriesKey,
      parameter,
      address,
      sourceName,
      value,
      sourceObservedAt,
      receivedAt: serverReceivedAt,
    }];
  });
}

export function appendLiveEnergySamples(current: LiveEnergySample[], incoming: LiveEnergySample[], limit = 96) {
  const byId = new Map(current.map((sample) => [sample.id, sample]));
  for (const sample of incoming) byId.set(sample.id, sample);
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
    .slice(-Math.max(1, limit));
}

/**
 * A chart displays one source/register lane at a time so values from different
 * physical counters cannot be silently blended into one trend.
 */
export function selectLiveEnergySeries(samples: LiveEnergySample[], preferred?: Pick<RawTelemetryMetric, "parameter" | "address"> | null) {
  if (!samples.length) return [];
  const preferredParameter = normalized(preferred?.parameter);
  const preferredAddress = String(preferred?.address ?? "");
  const preferredSeries = samples.filter((sample) =>
    normalized(sample.parameter) === preferredParameter && sample.address === preferredAddress,
  );
  const candidates = preferredSeries.length ? preferredSeries : samples;
  const newest = candidates.reduce((current, sample) =>
    !current || Date.parse(sample.receivedAt) >= Date.parse(current.receivedAt) ? sample : current,
  null as LiveEnergySample | null);
  if (!newest) return [];
  return candidates
    .filter((sample) => sample.seriesKey === newest.seriesKey)
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
}