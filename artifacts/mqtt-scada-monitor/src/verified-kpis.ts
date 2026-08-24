import {
  type CalculationInput,
  type CalculationKey,
  type CalculationMethod,
  type TelemetryKpiRow,
  type VerifiedKpiCalculation,
  type VerifiedScadaKpis,
  SCADA_CALCULATION_PROFILE_VERSION,
} from "./telemetry-kpis.ts";

type EngineeringUnit = "kW" | "kWh" | "kWh/kWp" | "V" | "A" | "ratio" | "kWp";
type Semantic = "inverter-power" | "main-power" | "daily-energy" | "total-energy" | "installed-capacity" | "line-voltage" | "phase-current" | "power-factor";
type CalculationOptions = {
  snapshotWindow?: VerifiedKpiCalculation["snapshotWindow"];
  asOf?: number;
  maximumAgeMs?: number;
};

const UNAVAILABLE_FORMULAS: Record<CalculationKey, string> = {
  acPower: "Awaiting an approved active-power source.",
  dailyEnergy: "Awaiting a verified daily energy counter.",
  totalEnergy: "Awaiting a verified cumulative energy counter.",
  specificYield: "Daily energy ÷ installed DC capacity",
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numeric(row: TelemetryKpiRow) {
  const value = typeof row.data === "number" ? row.data : typeof row.data === "string" ? Number(row.data) : NaN;
  return Number.isFinite(value) ? value : null;
}

function observedMs(row: TelemetryKpiRow) {
  const candidate = row.date_iso_8601 ?? row.timestamp ?? row.date;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate < 1_000_000_000_000 ? candidate * 1_000 : candidate;
  if (typeof candidate === "string") {
    const asNumber = Number(candidate);
    if (Number.isFinite(asNumber)) return asNumber < 1_000_000_000_000 ? asNumber * 1_000 : asNumber;
    const parsed = new Date(candidate).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function observedAt(row: TelemetryKpiRow) {
  const milliseconds = observedMs(row);
  return milliseconds ? new Date(milliseconds).toISOString() : undefined;
}

function validated(row: TelemetryKpiRow) {
  return [
    row.scaling_validated, row.scalingValidated,
    row.engineering_value_validated, row.engineeringValueValidated,
    row.scaling_status, row.scalingStatus,
    row.validation_status, row.validationStatus,
  ].some((value) => value === true || ["validated", "confirmed", "approved"].includes(String(value).toLowerCase()));
}

function engineeringUnit(row: TelemetryKpiRow): EngineeringUnit | null {
  const source = row.engineering_unit ?? row.engineeringUnit ?? row.unit ?? row.units;
  const unit = normalized(source);
  if (["w", "watt", "watts", "kw", "kilowatt", "kilowatts", "mw", "megawatt", "megawatts"].includes(unit)) return "kW";
  if (["wh", "watt hour", "watthour", "kwh", "kilowatt hour", "kilowatthour", "mwh", "megawatt hour", "megawatthour"].includes(unit)) return "kWh";
  if (["v", "volt", "volts"].includes(unit)) return "V";
  if (["a", "amp", "amps", "ampere", "amperes"].includes(unit)) return "A";
  if (["ratio", "perunit", "pu", "unitless"].includes(unit)) return "ratio";
  if (["kwp", "kilowattpeak", "kilowattsp"].includes(unit)) return "kWp";
  return null;
}

function convertedValue(row: TelemetryKpiRow, target: EngineeringUnit) {
  const value = numeric(row);
  const unit = engineeringUnit(row);
  if (value === null || !unit || unit !== target) return null;
  const sourceUnit = normalized(row.engineering_unit ?? row.engineeringUnit ?? row.unit ?? row.units);
  if (target === "kW") return sourceUnit === "w" || sourceUnit === "watt" || sourceUnit === "watts" ? value / 1000 : sourceUnit === "mw" || sourceUnit === "megawatt" || sourceUnit === "megawatts" ? value * 1000 : value;
  if (target === "kWh") return sourceUnit === "wh" || sourceUnit === "watthour" || sourceUnit === "watthour" ? value / 1000 : sourceUnit === "mwh" || sourceUnit === "megawatthour" ? value * 1000 : value;
  return value;
}

function semantic(row: TelemetryKpiRow): Semantic | null {
  const name = normalized(row.name);
  const declared = normalized(row.measurement_type ?? row.measurementType ?? row.semantic ?? row.metric ?? row.kind ?? row.engineering_semantic ?? row.engineeringSemantic);
  // A register name is only a transport label. An approved semantic identifier
  // must arrive with the source record before it can participate in a KPI.
  if (!declared) return null;
  if ((/^inv\d+(activepower|acpower|power)$/.test(name) || /^inv\d+$/.test(name)) && ["activepower", "acpower", "power"].includes(declared)) return "inverter-power";
  if (["actpow", "mainmeteractivepower", "gridactivepower", "plantactivepower"].includes(name) && ["activepower", "acpower", "power"].includes(declared)) return "main-power";
  if (["dailyenergy", "dailyenergykwh", "dailyeneregykwh", "todayenergy", "todayenergykwh"].includes(name) && ["dailyenergy", "dailyenergycounter", "energycounter"].includes(declared)) return "daily-energy";
  if (["totalenergy", "totalenergykwh", "lifetimeenergy", "lifetimeenergykwh"].includes(name) && ["totalenergy", "cumulativeenergy", "lifetimeenergy", "energycounter"].includes(declared)) return "total-energy";
  if (["installedcapacity", "installedcapacitykwp", "plantcapacity", "plantcapacitykwp", "dccapacity", "dccapacitykwp"].includes(name) && ["installedcapacity", "dccapacity", "plantcapacity"].includes(declared)) return "installed-capacity";
  if (["phaseabvoltage", "phasebcvoltage", "phasecavoltage"].includes(name) && ["linevoltage", "voltage"].includes(declared)) return "line-voltage";
  if (["acurrent", "phaseacurrent", "iacurrent"].includes(name) && ["phasecurrent", "current"].includes(declared)) return "phase-current";
  if (["pf", "powerfactor"].includes(name) && ["powerfactor", "pf"].includes(declared)) return "power-factor";
  return null;
}

function input(row: TelemetryKpiRow, value: number, unit: string, semanticName: string): CalculationInput {
  return {
    parameter: String(row.name ?? "register"),
    value,
    address: String(row.full_addr ?? row.addr ?? "—"),
    provenance: row.provenance === "replay" ? "replay" : "live",
    unit,
    semantic: semanticName,
    observedAt: observedAt(row),
  };
}

function latestRows(rows: TelemetryKpiRow[], requiredSemantic: Semantic, unit: EngineeringUnit, options: CalculationOptions) {
  const latest = new Map<string, { row: TelemetryKpiRow; value: number }>();
  for (const row of rows) {
    if (!validated(row) || semantic(row) !== requiredSemantic) continue;
    if (options.asOf !== undefined && options.maximumAgeMs !== undefined && observedMs(row) < options.asOf - options.maximumAgeMs) continue;
    const value = convertedValue(row, unit);
    if (value === null) continue;
    const identity = `${normalized(row.server_name)}|${normalized(row.name)}|${String(row.full_addr ?? row.addr ?? "")}`;
    const existing = latest.get(identity);
    if (!existing || observedMs(row) >= observedMs(existing.row)) latest.set(identity, { row, value });
  }
  return [...latest.values()];
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function rejectOutliers(metrics: CalculationInput[]) {
  if (metrics.length < 3) return { included: metrics, excluded: [] as CalculationInput[] };
  const centre = median(metrics.map((metric) => metric.value));
  const medianDeviation = median(metrics.map((metric) => Math.abs(metric.value - centre)));
  const permittedDeviation = Math.max(Math.abs(centre) * 4, medianDeviation * 10, 0.001);
  const included = metrics.filter((metric) => Math.abs(metric.value - centre) <= permittedDeviation);
  return { included, excluded: metrics.filter((metric) => !included.includes(metric)) };
}

function latest(rows: Array<{ row: TelemetryKpiRow; value: number }>) {
  return rows.reduce<{ row: TelemetryKpiRow; value: number } | null>((current, candidate) => !current || observedMs(candidate.row) >= observedMs(current.row) ? candidate : current, null);
}

function blank(key: CalculationKey, readiness: string, snapshotWindow?: VerifiedKpiCalculation["snapshotWindow"]): VerifiedKpiCalculation {
  const labels: Record<CalculationKey, string> = { acPower: "Total AC Power", dailyEnergy: "Today’s Energy", totalEnergy: "Total Energy", specificYield: "Specific Yield" };
  return {
    key, label: labels[key], value: null, unit: null, quality: "awaiting-validation", method: "unavailable",
    formula: UNAVAILABLE_FORMULAS[key], inputs: [], excluded: [], provenance: "unavailable",
    profileVersion: SCADA_CALCULATION_PROFILE_VERSION, readiness, snapshotWindow,
  };
}

function finish(key: CalculationKey, value: number, unit: VerifiedKpiCalculation["unit"], method: CalculationMethod, formula: string, inputs: CalculationInput[], excluded: CalculationInput[] = [], snapshotWindow?: VerifiedKpiCalculation["snapshotWindow"]): VerifiedKpiCalculation {
  const latestInput = inputs.reduce<CalculationInput | null>((current, candidate) => !current || new Date(candidate.observedAt ?? 0).getTime() >= new Date(current.observedAt ?? 0).getTime() ? candidate : current, null);
  const provenance = snapshotWindow ? "snapshot" : inputs.some((item) => item.provenance === "live") ? "live" : "replay";
  return {
    key, label: ({ acPower: "Total AC Power", dailyEnergy: "Today’s Energy", totalEnergy: "Total Energy", specificYield: "Specific Yield" })[key],
    value, unit, quality: "verified", method, formula, inputs, excluded, calculatedAt: latestInput?.observedAt,
    provenance, profileVersion: SCADA_CALCULATION_PROFILE_VERSION,
    readiness: snapshotWindow ? "Verified from the saved snapshot window." : "Verified from the latest approved source records.",
    snapshotWindow,
  };
}

export function calculateVerifiedScadaKpis(rows: TelemetryKpiRow[], options: CalculationOptions = {}): VerifiedScadaKpis {
  const { snapshotWindow } = options;
  const inverterInputs = latestRows(rows, "inverter-power", "kW", options).map(({ row, value }) => input(row, value, "kW", "active power"));
  const inverterSelection = rejectOutliers(inverterInputs);
  let acPower = inverterSelection.included.length
    ? finish("acPower", inverterSelection.included.reduce((sum, item) => sum + item.value, 0), "kW", "inverter-sum", "Σ latest approved inverter active-power readings", inverterSelection.included, inverterSelection.excluded, snapshotWindow)
    : null;
  if (!acPower) {
    const main = latest(latestRows(rows, "main-power", "kW", options));
    if (main) acPower = finish("acPower", main.value, "kW", "main-meter", "Approved main-meter active power", [input(main.row, main.value, "kW", "active power")], [], snapshotWindow);
  }
  if (!acPower) {
    const voltage = latest(latestRows(rows, "line-voltage", "V", options));
    const current = latest(latestRows(rows, "phase-current", "A", options));
    const powerFactor = latest(latestRows(rows, "power-factor", "ratio", options));
    if (voltage && current && powerFactor) {
      const inputs = [input(voltage.row, voltage.value, "V", "line-to-line voltage"), input(current.row, current.value, "A", "phase current"), input(powerFactor.row, powerFactor.value, "ratio", "power factor")];
      acPower = finish("acPower", Math.sqrt(3) * voltage.value * current.value * powerFactor.value / 1000, "kW", "three-phase", "√3 × line-to-line voltage × current × power factor ÷ 1,000", inputs, [], snapshotWindow);
    }
  }

  const daily = latest(latestRows(rows, "daily-energy", "kWh", options));
  const dailyEnergy = daily
    ? finish("dailyEnergy", daily.value, "kWh", "daily-counter", "Approved daily cumulative energy counter", [input(daily.row, daily.value, "kWh", "daily energy")], [], snapshotWindow)
    : blank("dailyEnergy", "A daily energy counter needs approved scaling, a compatible kWh unit, and source semantics.", snapshotWindow);

  const inverterEnergy = rejectOutliers(latestRows(rows, "total-energy", "kWh", options).filter(({ row }) => /^inv\d+/.test(normalized(row.name))).map(({ row, value }) => input(row, value, "kWh", "cumulative energy")));
  let totalEnergy = inverterEnergy.included.length
    ? finish("totalEnergy", inverterEnergy.included.reduce((sum, item) => sum + item.value, 0), "kWh", "inverter-energy-sum", "Σ latest approved inverter cumulative-energy counters", inverterEnergy.included, inverterEnergy.excluded, snapshotWindow)
    : null;
  if (!totalEnergy) {
    const meter = latest(latestRows(rows, "total-energy", "kWh", options).filter(({ row }) => !/^inv\d+/.test(normalized(row.name))));
    if (meter) totalEnergy = finish("totalEnergy", meter.value, "kWh", "totalizing-meter", "Approved totalizing energy meter", [input(meter.row, meter.value, "kWh", "cumulative energy")], [], snapshotWindow);
  }

  const capacity = latest(latestRows(rows, "installed-capacity", "kWp", options));
  const specificYield = dailyEnergy.quality === "verified" && capacity
    ? finish("specificYield", dailyEnergy.value! / capacity.value, "kWh/kWp", "specific-yield", "Verified daily energy ÷ approved installed DC capacity", [...dailyEnergy.inputs, input(capacity.row, capacity.value, "kWp", "installed DC capacity")], [], snapshotWindow)
    : blank("specificYield", !capacity ? "Specific yield needs an approved installed DC capacity in kWp as well as verified daily energy." : "Specific yield is waiting for verified daily energy.", snapshotWindow);

  return {
    acPower: acPower ?? blank("acPower", "Use approved inverter active-power records, a verified main meter, or all three validated electrical inputs.", snapshotWindow),
    dailyEnergy,
    totalEnergy: totalEnergy ?? blank("totalEnergy", "A cumulative energy counter needs approved scaling, a compatible kWh unit, and source semantics.", snapshotWindow),
    specificYield,
  };
}

export function selectVerifiedCalculation(live: VerifiedKpiCalculation, snapshot: VerifiedKpiCalculation): VerifiedKpiCalculation {
  if (live.quality === "verified") return live;
  if (snapshot.quality === "verified") return snapshot;
  return live;
}