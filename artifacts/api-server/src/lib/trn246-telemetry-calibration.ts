type SourceVocabularyEntry = {
  parameter: string;
  address: string;
  displayName: string;
  reportedUnit?: string;
  sourceCounterRole?: "daily-counter" | "cumulative-counter";
  inverterId?: string;
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function addressOf(parameter: Record<string, unknown>) {
  return String(parameter.full_addr ?? parameter.address ?? parameter.register ?? parameter.addr ?? "").replace(/\D/g, "");
}

function sourceOf(parameter: Record<string, unknown>) {
  return normalized(parameter.server_name ?? parameter.source ?? parameter.device ?? parameter.server);
}

function firstDefined(source: Record<string, unknown>, keys: string[]) {
  return keys.map((key) => source[key]).find((value) => value !== undefined && value !== null && value !== "");
}

/**
 * A reviewed vocabulary describes source labels, units, and identities found
 * in the vendor's TRN246 export. It deliberately has no multiplier: a
 * vocabulary makes evidence readable, while a plant calibration profile is
 * the separate, auditable authority for engineering scaling and KPIs.
 */
const TRN246_SOURCE_VOCABULARY: SourceVocabularyEntry[] = [
  { parameter: "phaseabvoltage", address: "305019", displayName: "Phase AB Voltage", reportedUnit: "V" },
  { parameter: "phasebcvoltage", address: "305020", displayName: "Phase BC Voltage", reportedUnit: "V" },
  { parameter: "phasecavoltage", address: "305021", displayName: "Phase CA Voltage", reportedUnit: "V" },
  { parameter: "acurrent", address: "305022", displayName: "Phase A Current", reportedUnit: "A" },
  { parameter: "bcurrent", address: "305023", displayName: "Phase B Current", reportedUnit: "A" },
  { parameter: "ccurrent", address: "305024", displayName: "Phase C Current", reportedUnit: "A" },
  { parameter: "actpow", address: "305031", displayName: "Active Power", reportedUnit: "kW" },
  { parameter: "pf", address: "305035", displayName: "Power Factor", reportedUnit: "PF" },
  { parameter: "frq", address: "305036", displayName: "Frequency", reportedUnit: "Hz" },
  { parameter: "todayyield", address: "305003", displayName: "Today Yield", reportedUnit: "MWh", sourceCounterRole: "daily-counter" },
  { parameter: "dailyeneregykwh", address: "305005", displayName: "Daily Energy", reportedUnit: "MWh", sourceCounterRole: "daily-counter" },
  { parameter: "totalenergy", address: "305008", displayName: "Total Energy", reportedUnit: "MWh", sourceCounterRole: "cumulative-counter" },
  { parameter: "internaltemperature", address: "305124", displayName: "Internal Temperature", reportedUnit: "°C" },
  { parameter: "string1current", address: "307013", displayName: "String 1 Current", reportedUnit: "A" },
  { parameter: "str2a", address: "307014", displayName: "String 2 Current", reportedUnit: "A" },
  { parameter: "str3a", address: "307015", displayName: "String 3 Current", reportedUnit: "A" },
  { parameter: "str4a", address: "307016", displayName: "String 4 Current", reportedUnit: "A" },
  { parameter: "str5a", address: "307017", displayName: "String 5 Current", reportedUnit: "A" },
  { parameter: "str6a", address: "307018", displayName: "String 6 Current", reportedUnit: "A" },
  ...[1, 2, 3, 4, 5].map((number) => ({
    parameter: `inv${number}`,
    address: "305003",
    displayName: `Inverter ${number} identity`,
    inverterId: `inv${number}`,
  })),
];

function reportedValue(parameter: Record<string, unknown>) {
  return firstDefined(parameter, [
    "customer_value", "customerValue", "reported_value", "reportedValue",
    "engineering_value", "engineeringValue", "data", "value", "currentValue", "current_value",
  ]);
}

function hasExplicitReportedValue(parameter: Record<string, unknown>) {
  return firstDefined(parameter, [
    "customer_value", "customerValue", "reported_value", "reportedValue",
    "engineering_value", "engineeringValue",
  ]) !== undefined || (
    parameter.data !== undefined
    && firstDefined(parameter, ["raw_data", "rawValue", "raw_value", "source_raw_value", "sourceRawValue"]) !== undefined
  );
}

/**
 * Keeps vendor-reported fields distinct from the Modbus transport value.
 * This function used to apply implicit multipliers and mark rows validated.
 * It now only annotates a reviewed source vocabulary; approved calibration
 * profiles remain the sole path to a validated engineering KPI.
 */
export function applyTrn246TelemetryCalibration(parameter: Record<string, unknown>) {
  if (sourceOf(parameter) !== "ana") return parameter;

  const parameterName = normalized(parameter.name ?? parameter.parameter ?? parameter.tag);
  const address = addressOf(parameter);
  const entry = TRN246_SOURCE_VOCABULARY.find((candidate) => candidate.parameter === parameterName && candidate.address === address);
  if (!entry) return parameter;

  const reported = reportedValue(parameter);
  const transportRaw = firstDefined(parameter, ["raw_data", "rawValue", "raw_value", "source_raw_value", "sourceRawValue"]) ?? parameter.data;
  const sourceReported = hasExplicitReportedValue(parameter);
  const sourceUnit = text(firstDefined(parameter, ["reported_unit", "reportedUnit", "customer_unit", "customerUnit", "source_unit", "sourceUnit"]))
    ?? (sourceReported ? entry.reportedUnit : undefined);
  const sourceIdentity = ["trn246", "ana", entry.parameter, entry.address].join("|");

  return {
    ...parameter,
    display_name: text(parameter.display_name ?? parameter.displayName ?? parameter.label) ?? entry.displayName,
    reported_value: reported,
    reported_unit: sourceUnit,
    source_raw_value: transportRaw,
    source_identity: sourceIdentity,
    source_mapping_status: sourceReported ? "source-reported" : "raw",
    source_mapping: "Reviewed TRN246 vendor telemetry vocabulary",
    source_counter_role: entry.sourceCounterRole,
    ...(entry.inverterId ? {
      inverter_id: entry.inverterId,
      inverter_name: `Inverter ${entry.inverterId.slice(3).padStart(2, "0")}`,
      measurement_type: "inverter_identity",
      semantic: "inverter_identity",
      calibration_note: "Identity register; source-reported evidence only until active-power semantics and scaling are approved.",
    } : {}),
  };
}