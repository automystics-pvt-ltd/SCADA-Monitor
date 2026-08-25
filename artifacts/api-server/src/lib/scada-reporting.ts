export const SCADA_REPORT_TYPES = [
  "operations",
  "electrical",
  "energy",
  "inverter",
  "environmental",
  "alarms",
  "communication",
  "live",
  "historical",
  "comparison",
  "availability",
  "data-quality",
  "plant-monitoring",
  "inverter-monitoring",
  "electrical-parameters",
  "ac-dc-power",
  "energy-generation",
  "mppt-monitoring",
  "string-monitoring",
  "temperature-monitoring",
  "power-factor-frequency",
  "alarm-fault",
  "device-communication",
  "mqtt-modbus-telemetry",
  "live-data",
  "historical-saved",
] as const;

export type ScadaReportType = typeof SCADA_REPORT_TYPES[number];
export type ReportProvenance = "live" | "latest-saved" | "historical-saved";
export type ReportQuality = "validated" | "source-reported" | "raw";
export type ScadaReportCategory =
  | "operations"
  | "electrical"
  | "energy"
  | "inverter"
  | "environmental"
  | "alarms"
  | "communication";

export type ReportFilterSet = {
  devices: string[];
  parameters: string[];
  provenance: ReportProvenance[];
  quality: "all" | "validated" | "source-reported";
  status: "all" | "active" | "warning" | "normal";
};

export type ScadaReportRecord = {
  id: string;
  recordType: "measurement" | "energy" | "snapshot" | "alarm" | "communication";
  category: ScadaReportCategory;
  siteName: string;
  deviceId: string | null;
  deviceName: string | null;
  parameter: string;
  displayLabel: string;
  measurementKind?: string;
  value: number | null;
  unit: string;
  address: string;
  sourceName: string;
  observedAt: string;
  receivedAt: string;
  provenance: ReportProvenance;
  quality: ReportQuality;
  status: string | null;
  reason: string | null;
  sourceReportedValue?: string | null;
  sourceReportedUnit?: string | null;
  transportRawValue?: string | null;
  sourceIdentity?: string | null;
};

function normalized(value: string) {
  return value.trim().toLowerCase();
}

export function reportCategoryForParameter(parameter: string): ScadaReportCategory {
  const key = normalized(parameter);
  if (/(alarm|fault|trip|error|warning)/.test(key)) return "alarms";
  if (/(irradiance|temperature|humidity|wind|rain|weather|ambient|environment)/.test(key)) return "environmental";
  if (/(energy|yield|generation|kwh|mwh)/.test(key)) return "energy";
  if (/(voltage|current|amper|frequency|powerfactor|reactive|electrical|activepower|acpower|dcpower|realpower)/.test(key)) return "electrical";
  if (/(inverter|inv)/.test(key)) return "inverter";
  return "operations";
}

function reportParameterKey(record: Pick<ScadaReportRecord, "parameter" | "displayLabel">) {
  return normalized(`${record.parameter} ${record.displayLabel}`);
}

function isPowerParameter(record: Pick<ScadaReportRecord, "parameter" | "displayLabel"> & { measurementKind?: string }) {
  return record.measurementKind === "active-power"
    || record.measurementKind === "dc-power"
    || /(ac[\s_-]*power|dc[\s_-]*power|active[\s_-]*power|real[\s_-]*power|pv\d*[\s_-]*power|input[\s_-]*power|power[\s_-]*output)/.test(reportParameterKey(record));
}

function isMpptParameter(record: Pick<ScadaReportRecord, "parameter" | "displayLabel">) {
  return /(?:mppt|maximum[\s_-]*power[\s_-]*point|tracker)/.test(reportParameterKey(record));
}

function isStringParameter(record: Pick<ScadaReportRecord, "parameter" | "displayLabel">) {
  return /(?:string|pv[\s_-]*string|string[\s_-]*input|input[\s_-]*string)/.test(reportParameterKey(record));
}

function isTemperatureParameter(record: Pick<ScadaReportRecord, "parameter" | "displayLabel">) {
  return /(?:temperature|temp|thermal|heatsink|cabinet)/.test(reportParameterKey(record));
}

function isPowerFactorFrequencyParameter(record: Pick<ScadaReportRecord, "parameter" | "displayLabel">) {
  return /(?:power[\s_-]*factor|powerfactor|frequency|freq|hz)/.test(reportParameterKey(record));
}

export function reportTypeMatchesRecord(type: ScadaReportType, record: ScadaReportRecord) {
  const parameterKey = reportParameterKey(record);
  switch (type) {
    case "plant-monitoring":
      return true;
    case "inverter-monitoring":
      return Boolean(record.deviceId) || record.category === "inverter";
    case "electrical-parameters":
      return record.category === "electrical" && !isPowerParameter(record) && !isPowerFactorFrequencyParameter(record) && !isMpptParameter(record) && !isStringParameter(record) && !isTemperatureParameter(record);
    case "ac-dc-power":
      return isPowerParameter(record);
    case "energy-generation":
      return record.category === "energy";
    case "mppt-monitoring":
      return isMpptParameter(record);
    case "string-monitoring":
      return isStringParameter(record);
    case "temperature-monitoring":
      return isTemperatureParameter(record);
    case "power-factor-frequency":
      return isPowerFactorFrequencyParameter(record);
    case "alarm-fault":
      return record.category === "alarms";
    case "device-communication":
      return record.category === "communication";
    case "mqtt-modbus-telemetry":
      return record.recordType === "measurement" || record.recordType === "snapshot" || record.recordType === "communication";
    case "live-data":
      return record.provenance === "live";
    case "historical-saved":
      return record.provenance === "latest-saved" || record.provenance === "historical-saved";
    case "operations":
      return ["operations", "inverter", "alarms", "communication"].includes(record.category);
    case "electrical":
      return record.category === "electrical";
    case "energy":
      return record.category === "energy";
    case "inverter":
      return ["inverter", "electrical", "energy"].includes(record.category);
    case "environmental":
      return record.category === "environmental";
    case "alarms":
      return record.category === "alarms";
    case "communication":
      return record.category === "communication";
    case "live":
      return record.provenance === "live";
    case "historical":
      return record.provenance === "latest-saved" || record.provenance === "historical-saved";
    case "comparison":
      return ["inverter", "energy", "electrical"].includes(record.category);
    case "availability":
      return ["communication", "operations"].includes(record.category);
    case "data-quality":
      return true;
    default:
      return parameterKey.length > 0;
  }
}

export function sourceExplicitlyValidatesEngineeringValue(parameter: Record<string, unknown>) {
  return [
    parameter.scaling_validated,
    parameter.scalingValidated,
    parameter.engineering_value_validated,
    parameter.engineeringValueValidated,
    parameter.scaling_status,
    parameter.scalingStatus,
    parameter.validation_status,
    parameter.validationStatus,
  ].some((value) => value === true || ["validated", "confirmed", "approved"].includes(String(value).toLowerCase()));
}

export function reportTypeIncludesCategory(type: ScadaReportType, category: ScadaReportCategory) {
  const categories: Record<ScadaReportType, ScadaReportCategory[]> = {
    operations: ["operations", "inverter", "alarms", "communication"],
    electrical: ["electrical"],
    energy: ["energy"],
    inverter: ["inverter", "electrical", "energy"],
    environmental: ["environmental"],
    alarms: ["alarms"],
    communication: ["communication"],
    live: ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    historical: ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    comparison: ["inverter", "energy", "electrical"],
    availability: ["communication", "operations"],
    "data-quality": ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    "plant-monitoring": ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    "inverter-monitoring": ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    "electrical-parameters": ["electrical"],
    "ac-dc-power": ["electrical", "operations"],
    "energy-generation": ["energy"],
    "mppt-monitoring": ["electrical", "operations"],
    "string-monitoring": ["electrical", "operations"],
    "temperature-monitoring": ["electrical", "environmental", "operations"],
    "power-factor-frequency": ["electrical", "operations"],
    "alarm-fault": ["alarms"],
    "device-communication": ["communication"],
    "mqtt-modbus-telemetry": ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    "live-data": ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
    "historical-saved": ["operations", "inverter", "electrical", "energy", "environmental", "alarms", "communication"],
  };
  return categories[type].includes(category);
}

export function stableReportRecordId(parts: {
  source: string;
  siteName?: string;
  deviceId?: string | null;
  parameter: string;
  address: string;
  observedAt: string;
  receivedAt: string;
  value: string | number | null;
}) {
  return [parts.source, parts.siteName ?? "", parts.deviceId ?? "", parts.parameter, parts.address, parts.observedAt, parts.receivedAt, String(parts.value ?? "")].join("|");
}

export function keepReportRecord(record: ScadaReportRecord, type: ScadaReportType, filters: ReportFilterSet) {
  if (!reportTypeIncludesCategory(type, record.category) || !reportTypeMatchesRecord(type, record)) return false;
  if (filters.provenance.length && !filters.provenance.includes(record.provenance)) return false;
  if (filters.quality !== "all" && record.quality !== filters.quality) return false;
  if (filters.devices.length) {
    const device = normalized(record.deviceId ?? record.deviceName ?? "");
    if (!filters.devices.some((candidate) => device === normalized(candidate))) return false;
  }
  if (filters.parameters.length) {
    const parameter = normalized(record.parameter);
    if (!filters.parameters.some((candidate) => parameter === normalized(candidate))) return false;
  }
  if (filters.status === "active" && record.status !== "active") return false;
  if (filters.status === "warning" && record.status !== "warning") return false;
  if (filters.status === "normal" && record.status !== "normal") return false;
  return true;
}