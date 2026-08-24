export type TelemetryKpiRow = Record<string, unknown>;

export type RawTelemetryMetric = {
  parameter: string;
  value: number;
  address: string;
  provenance: "live" | "replay";
};

function normalizedParameter(row: TelemetryKpiRow) {
  return String(row.name ?? "").trim().toLowerCase();
}

function rowTimestamp(row: TelemetryKpiRow) {
  const candidates = [row.date_iso_8601, row.timestamp, row.date];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate < 1_000_000_000_000 ? candidate * 1_000 : candidate;
    }
    if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
      const parsed = new Date(candidate).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function numericValue(row: TelemetryKpiRow) {
  const value = typeof row.data === "number" ? row.data : typeof row.data === "string" ? Number(row.data) : NaN;
  return Number.isFinite(value) ? value : null;
}

function asRawMetric(row: TelemetryKpiRow): RawTelemetryMetric | null {
  const value = numericValue(row);
  if (value === null) return null;
  return {
    parameter: String(row.name ?? "register"),
    value,
    address: String(row.full_addr ?? row.addr ?? "—"),
    provenance: row.provenance === "replay" ? "replay" : "live",
  };
}

export function latestRawMetric(rows: TelemetryKpiRow[], parameterNames: string[]) {
  const names = new Set(parameterNames.map((name) => name.toLowerCase()));
  const matches = rows
    .filter((row) => names.has(normalizedParameter(row)))
    .map((row) => ({ row, metric: asRawMetric(row) }))
    .filter((item): item is { row: TelemetryKpiRow; metric: RawTelemetryMetric } => item.metric !== null);

  if (!matches.length) return null;
  return matches.reduce((latest, candidate) => rowTimestamp(candidate.row) > rowTimestamp(latest.row) ? candidate : latest).metric;
}

export function rawInverterSignals(rows: TelemetryKpiRow[]) {
  return rows
    .filter((row) => /^inv\d+$/i.test(normalizedParameter(row)))
    .map((row) => ({ row, metric: asRawMetric(row) }))
    .filter((item): item is { row: TelemetryKpiRow; metric: RawTelemetryMetric } => item.metric !== null)
    .sort((left, right) => left.metric.parameter.localeCompare(right.metric.parameter))
    .map((item) => item.metric);
}

export function rawMetricContext(metric: RawTelemetryMetric | null, fallback: string) {
  if (!metric) return fallback;
  const source = metric.provenance === "live" ? "Live" : "Replay";
  return `${source} raw ${metric.parameter} · register ${metric.address} · scaling required`;
}