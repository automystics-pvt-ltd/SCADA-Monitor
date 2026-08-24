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
  if (!reportTypeIncludesCategory(type, record.category)) return false;
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