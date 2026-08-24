export type TelemetryKpiRow = Record<string, unknown>;

export type RawTelemetryMetric = {
  parameter: string;
  value: number;
  address: string;
  provenance: "live" | "retained" | "recovered" | "replay";
};

export type ScadaAggregate = {
  value: number | null;
  method: "inverter-sum" | "main-meter" | "three-phase" | "inverter-energy-sum" | "totalizing-meter" | "unavailable";
  unit: "raw" | "W";
  included: RawTelemetryMetric[];
  excluded: RawTelemetryMetric[];
  source: RawTelemetryMetric | null;
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
  parameters: TelemetryKpiRow[];
  metrics: {
    activePower: SavedSnapshotMetric | null;
    dailyEnergy: SavedSnapshotMetric | null;
    totalEnergy: SavedSnapshotMetric | null;
    specificYield: SavedSnapshotMetric | null;
  };
};

export const SAVED_KPI_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
export type SavedKpiEvidenceSource = "live" | "saved" | "unavailable";
export type SavedKpiEvidenceSelection = {
  source: SavedKpiEvidenceSource;
  snapshot: SavedKpiSnapshot | null;
};

export type CalculationKey = "acPower" | "dailyEnergy" | "totalEnergy" | "specificYield";
export type CalculationQuality = "verified" | "awaiting-validation";
export type CalculationMethod =
  | "inverter-sum"
  | "main-meter"
  | "three-phase"
  | "daily-counter"
  | "inverter-energy-sum"
  | "totalizing-meter"
  | "specific-yield"
  | "unavailable";

export type CalculationInput = RawTelemetryMetric & {
  unit: string;
  observedAt?: string;
  semantic: string;
};

export type VerifiedKpiCalculation = {
  key: CalculationKey;
  label: string;
  value: number | null;
  unit: "kW" | "kWh" | "kWh/kWp" | null;
  quality: CalculationQuality;
  method: CalculationMethod;
  formula: string;
  inputs: CalculationInput[];
  excluded: CalculationInput[];
  calculatedAt?: string;
  provenance: "live" | "replay" | "snapshot" | "unavailable";
  profileVersion: string;
  readiness: string;
  snapshotWindow?: { startedAt: string; endedAt: string; scheduledFor: string };
};

export type VerifiedScadaKpis = Record<CalculationKey, VerifiedKpiCalculation>;

export const SCADA_CALCULATION_PROFILE_VERSION = "source-metadata-v1";

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
    parameters: Array.isArray(value.parameters) ? value.parameters.filter(isRecord) : [],
    metrics: {
      activePower: parseSavedMetric(value.metrics.activePower),
      dailyEnergy: parseSavedMetric(value.metrics.dailyEnergy),
      totalEnergy: parseSavedMetric(value.metrics.totalEnergy),
      specificYield: parseSavedMetric(value.metrics.specificYield),
    },
  };
}

export function isEligibleSavedKpiSnapshot(
  snapshot: SavedKpiSnapshot | null,
  now: number,
  maximumAgeMs = SAVED_KPI_SNAPSHOT_MAX_AGE_MS,
) {
  if (
    !snapshot
    || snapshot.saveStatus !== "saved"
    || snapshot.parameters.length === 0
    || !Number.isFinite(now)
    || !Number.isFinite(maximumAgeMs)
    || maximumAgeMs < 0
  ) {
    return false;
  }

  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt)) return false;

  const age = Math.max(0, now - capturedAt);
  return age <= maximumAgeMs;
}

export function selectSavedKpiEvidence(
  snapshot: SavedKpiSnapshot | null,
  options: { now: number; liveTelemetryFresh: boolean; maximumAgeMs?: number },
): SavedKpiEvidenceSelection {
  const eligibleSnapshot = isEligibleSavedKpiSnapshot(snapshot, options.now, options.maximumAgeMs);
  if (options.liveTelemetryFresh) {
    return { source: "live", snapshot: eligibleSnapshot ? snapshot : null };
  }
  if (eligibleSnapshot) return { source: "saved", snapshot };
  return { source: "unavailable", snapshot: null };
}

function calculationInput(row: TelemetryKpiRow, unit: string, semantic: string): CalculationInput | null {
  const raw = asRawMetric(row);
  if (!raw) return null;
  const timestamp = row.date_iso_8601 ?? row.timestamp ?? row.date;
  const observedAt = typeof timestamp === "string"
    ? timestamp
    : typeof timestamp === "number" && Number.isFinite(timestamp)
      ? new Date(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp).toISOString()
      : undefined;
  return { ...raw, unit, observedAt, semantic };
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

function normalizedKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
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
    .filter((row) => /^inv\d+$/i.test(normalizedParameter(row)) && normalizedKey(row.measurement_type ?? row.semantic) !== "inverteridentity")
    .map((row) => ({ row, metric: asRawMetric(row) }))
    .filter((item): item is { row: TelemetryKpiRow; metric: RawTelemetryMetric } => item.metric !== null)
    .sort((left, right) => left.metric.parameter.localeCompare(right.metric.parameter))
    .map((item) => item.metric);
}

function latestMetricMatching(rows: TelemetryKpiRow[], predicate: (name: string) => boolean) {
  const matches = rows
    .filter((row) => predicate(normalizedKey(row.name)))
    .map((row) => ({ row, metric: asRawMetric(row) }))
    .filter((item): item is { row: TelemetryKpiRow; metric: RawTelemetryMetric } => item.metric !== null);
  if (!matches.length) return null;
  return matches.reduce((latest, candidate) => rowTimestamp(candidate.row) > rowTimestamp(latest.row) ? candidate : latest);
}

function latestMetricsByParameter(rows: TelemetryKpiRow[], predicate: (name: string) => boolean) {
  const newest = new Map<string, { row: TelemetryKpiRow; metric: RawTelemetryMetric }>();
  for (const row of rows) {
    const parameter = normalizedKey(row.name);
    if (!predicate(parameter)) continue;
    const metric = asRawMetric(row);
    if (!metric) continue;
    const current = newest.get(parameter);
    if (!current || rowTimestamp(row) >= rowTimestamp(current.row)) newest.set(parameter, { row, metric });
  }
  return [...newest.values()].map((item) => item.metric);
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rejectPowerOutliers(metrics: RawTelemetryMetric[]) {
  if (metrics.length < 3) return { included: metrics, excluded: [] as RawTelemetryMetric[] };
  const centre = median(metrics.map((metric) => metric.value));
  const medianDeviation = median(metrics.map((metric) => Math.abs(metric.value - centre)));
  const permittedDeviation = Math.max(Math.abs(centre) * 4, medianDeviation * 10, 1);
  const included = metrics.filter((metric) => Math.abs(metric.value - centre) <= permittedDeviation);
  return { included, excluded: metrics.filter((metric) => !included.includes(metric)) };
}

function hasValidatedScaling(row: TelemetryKpiRow) {
  return [
    row.scaling_validated,
    row.scalingValidated,
    row.engineering_value_validated,
    row.engineeringValueValidated,
    row.scaling_status,
    row.scalingStatus,
    row.validation_status,
    row.validationStatus,
  ].some((value) => value === true || ["validated", "confirmed", "approved"].includes(String(value).toLowerCase()));
}

function latestValidatedMetric(rows: TelemetryKpiRow[], names: string[]) {
  const namesSet = new Set(names);
  const matches = rows
    .filter((row) => namesSet.has(normalizedKey(row.name)) && hasValidatedScaling(row))
    .map((row) => ({ row, metric: asRawMetric(row) }))
    .filter((item): item is { row: TelemetryKpiRow; metric: RawTelemetryMetric } => item.metric !== null);
  if (!matches.length) return null;
  return matches.reduce((latest, candidate) => rowTimestamp(candidate.row) > rowTimestamp(latest.row) ? candidate : latest);
}

export function calculateScadaAggregates(rows: TelemetryKpiRow[]) {
  const inverterPower = latestMetricsByParameter(
    rows.filter((row) => normalizedKey(row.measurement_type ?? row.semantic) !== "inverteridentity"),
    (name) => /^inv\d+$/.test(name),
  );
  const powerSelection = rejectPowerOutliers(inverterPower);
  const acPower: ScadaAggregate = powerSelection.included.length
    ? {
      value: powerSelection.included.reduce((sum, metric) => sum + metric.value, 0),
      method: "inverter-sum",
      unit: "raw",
      included: powerSelection.included,
      excluded: powerSelection.excluded,
      source: null,
    }
    : (() => {
      const mainMeter = latestMetricMatching(rows, (name) => ["actpow", "mainmeteractivepower", "gridactivepower", "plantactivepower"].includes(name));
      if (mainMeter) {
        return { value: mainMeter.metric.value, method: "main-meter" as const, unit: "raw" as const, included: [mainMeter.metric], excluded: [], source: mainMeter.metric };
      }
      const lineVoltage = latestValidatedMetric(rows, ["phaseabvoltage", "phasebcvoltage", "phasecavoltage"]);
      const phaseCurrent = latestValidatedMetric(rows, ["acurrent", "phaseacurrent", "iacurrent"]);
      const powerFactor = latestValidatedMetric(rows, ["pf", "powerfactor"]);
      if (lineVoltage && phaseCurrent && powerFactor) {
        return {
          value: Math.sqrt(3) * lineVoltage.metric.value * phaseCurrent.metric.value * powerFactor.metric.value,
          method: "three-phase" as const,
          unit: "W" as const,
          included: [lineVoltage.metric, phaseCurrent.metric, powerFactor.metric],
          excluded: [],
          source: null,
        };
      }
      return { value: null, method: "unavailable" as const, unit: "raw" as const, included: [], excluded: [], source: null };
    })();

  const inverterEnergy = latestMetricsByParameter(rows, (name) => /^inv\d+.*(totalenergy|lifetimeenergy|energykwh|dailyenergy|todayenergy|yield)$/.test(name));
  const energySelection = rejectPowerOutliers(inverterEnergy);
  const totalEnergy: ScadaAggregate = energySelection.included.length
    ? {
      value: energySelection.included.reduce((sum, metric) => sum + metric.value, 0),
      method: "inverter-energy-sum",
      unit: "raw",
      included: energySelection.included,
      excluded: energySelection.excluded,
      source: null,
    }
    : (() => {
      const totalizingMeter = latestMetricMatching(rows, (name) => ["totalenergy", "totalenergykwh", "lifetimeenergy", "lifetimeenergykwh"].includes(name));
      return totalizingMeter
        ? { value: totalizingMeter.metric.value, method: "totalizing-meter" as const, unit: "raw" as const, included: [totalizingMeter.metric], excluded: [], source: totalizingMeter.metric }
        : { value: null, method: "unavailable" as const, unit: "raw" as const, included: [], excluded: [], source: null };
    })();

  return { acPower, totalEnergy };
}

export function rawMetricContext(metric: RawTelemetryMetric | null, fallback: string) {
  if (!metric) return fallback;
  const source = metric.provenance === "live" ? "Live" : metric.provenance === "retained" ? "Retained broker evidence" : metric.provenance === "recovered" ? "Recovered evidence" : "Replay";
  return `${source} raw ${metric.parameter} · register ${metric.address} · scaling required`;
}