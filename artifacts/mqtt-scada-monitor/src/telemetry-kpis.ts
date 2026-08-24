export type TelemetryKpiRow = Record<string, unknown>;

export type RawTelemetryMetric = {
  parameter: string;
  value: number;
  address: string;
  provenance: "live" | "replay";
};

export type SavedSnapshotMetric = {
  parameter: string;
  value: number;
  rawData: string;
  address: string;
  sourceTimestamp?: string;
};

export type SavedKpiSnapshot = {
  id: number;
  topic: string;
  windowStartedAt: string;
  windowEndedAt: string;
  scheduledFor: string;
  capturedAt: string;
  timezone?: string;
  saveStatus: "saved" | "missing" | "incomplete";
  missingReason?: string;
  messageCount: number;
  parameterCount: number;
  metrics: {
    activePower: SavedSnapshotMetric | null;
    dailyEnergy: SavedSnapshotMetric | null;
    totalEnergy: SavedSnapshotMetric | null;
    specificYield: SavedSnapshotMetric | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSavedMetric(value: unknown): SavedSnapshotMetric | null {
  if (!isRecord(value)) return null;
  const numeric = typeof value.value === "number" ? value.value : typeof value.value === "string" ? Number(value.value) : NaN;
  if (!Number.isFinite(numeric) || typeof value.parameter !== "string" || typeof value.address !== "string" || typeof value.rawData !== "string") return null;
  return {
    parameter: value.parameter,
    value: numeric,
    address: value.address,
    rawData: value.rawData,
    sourceTimestamp: typeof value.sourceTimestamp === "string" ? value.sourceTimestamp : undefined,
  };
}

export function parseSavedKpiSnapshot(value: unknown): SavedKpiSnapshot | null {
  if (!isRecord(value) || !isRecord(value.metrics)) return null;
  const id = typeof value.id === "number" ? value.id : Number(value.id);
  if (!Number.isInteger(id)) return null;
  const requiredStrings = ["topic", "windowStartedAt", "windowEndedAt", "scheduledFor", "capturedAt"] as const;
  if (requiredStrings.some((key) => typeof value[key] !== "string")) return null;
  const saveStatus = value.saveStatus;
  if (saveStatus !== "saved" && saveStatus !== "missing" && saveStatus !== "incomplete") return null;
  const messageCount = typeof value.messageCount === "number" ? value.messageCount : Number(value.messageCount);
  const parameterCount = typeof value.parameterCount === "number" ? value.parameterCount : Number(value.parameterCount);
  if (!Number.isFinite(messageCount) || !Number.isFinite(parameterCount)) return null;

  return {
    id,
    topic: value.topic as string,
    windowStartedAt: value.windowStartedAt as string,
    windowEndedAt: value.windowEndedAt as string,
    scheduledFor: value.scheduledFor as string,
    capturedAt: value.capturedAt as string,
    timezone: typeof value.timezone === "string" ? value.timezone : undefined,
    saveStatus,
    missingReason: typeof value.missingReason === "string" ? value.missingReason : undefined,
    messageCount,
    parameterCount,
    metrics: {
      activePower: parseSavedMetric(value.metrics.activePower),
      dailyEnergy: parseSavedMetric(value.metrics.dailyEnergy),
      totalEnergy: parseSavedMetric(value.metrics.totalEnergy),
      specificYield: parseSavedMetric(value.metrics.specificYield),
    },
  };
}

export function isNewerSavedKpiSnapshot(next: SavedKpiSnapshot, current: SavedKpiSnapshot | null) {
  if (!current) return true;
  const nextTime = new Date(next.scheduledFor).getTime();
  const currentTime = new Date(current.scheduledFor).getTime();
  if (!Number.isFinite(nextTime) || !Number.isFinite(currentTime)) return next.id >= current.id;
  if (nextTime !== currentTime) return nextTime > currentTime;
  return new Date(next.capturedAt).getTime() >= new Date(current.capturedAt).getTime();
}

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