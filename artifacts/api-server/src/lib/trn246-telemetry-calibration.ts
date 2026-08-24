type Calibration = {
  parameter: string;
  address: string;
  displayName: string;
  unit: string;
  multiplier: number;
  semantic: string;
};

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numericValue(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function addressOf(parameter: Record<string, unknown>) {
  return String(parameter.full_addr ?? parameter.address ?? parameter.register ?? parameter.addr ?? "").replace(/\D/g, "");
}

function sourceOf(parameter: Record<string, unknown>) {
  return normalized(parameter.server_name ?? parameter.source ?? parameter.device ?? parameter.server);
}

const TRN246_CALIBRATIONS: Calibration[] = [
  { parameter: "phaseabvoltage", address: "305019", displayName: "Phase AB Voltage", unit: "V", multiplier: 0.1, semantic: "line_voltage" },
  { parameter: "phasebcvoltage", address: "305020", displayName: "Phase BC Voltage", unit: "V", multiplier: 0.1, semantic: "line_voltage" },
  { parameter: "phasecavoltage", address: "305021", displayName: "Phase CA Voltage", unit: "V", multiplier: 0.1, semantic: "line_voltage" },
  { parameter: "acurrent", address: "305022", displayName: "Phase A Current", unit: "A", multiplier: 0.1, semantic: "phase_current" },
  { parameter: "bcurrent", address: "305023", displayName: "Phase B Current", unit: "A", multiplier: 0.1, semantic: "phase_current" },
  { parameter: "ccurrent", address: "305024", displayName: "Phase C Current", unit: "A", multiplier: 0.1, semantic: "phase_current" },
  { parameter: "actpow", address: "305031", displayName: "Active Power", unit: "kW", multiplier: 0.00001, semantic: "active_power" },
  { parameter: "pf", address: "305035", displayName: "Power Factor", unit: "PF", multiplier: 0.001, semantic: "power_factor" },
  { parameter: "frq", address: "305036", displayName: "Frequency", unit: "Hz", multiplier: 0.1, semantic: "frequency" },
  { parameter: "todayyield", address: "305003", displayName: "Today Yield", unit: "MWh", multiplier: 0.001, semantic: "daily_energy" },
  { parameter: "dailyeneregykwh", address: "305005", displayName: "Daily Energy", unit: "MWh", multiplier: 0.001, semantic: "daily_energy" },
  { parameter: "totalenergy", address: "305008", displayName: "Total Energy", unit: "MWh", multiplier: 0.001, semantic: "cumulative_energy" },
  { parameter: "internaltemperature", address: "305124", displayName: "Internal Temperature", unit: "°C", multiplier: 1, semantic: "temperature" },
  { parameter: "string1current", address: "307013", displayName: "String 1 Current", unit: "A", multiplier: 0.1, semantic: "string_current" },
  { parameter: "str2a", address: "307014", displayName: "String 2 Current", unit: "A", multiplier: 0.1, semantic: "string_current" },
  { parameter: "str3a", address: "307015", displayName: "String 3 Current", unit: "A", multiplier: 0.1, semantic: "string_current" },
  { parameter: "str4a", address: "307016", displayName: "String 4 Current", unit: "A", multiplier: 0.1, semantic: "string_current" },
  { parameter: "str5a", address: "307017", displayName: "String 5 Current", unit: "A", multiplier: 0.1, semantic: "string_current" },
  { parameter: "str6a", address: "307018", displayName: "String 6 Current", unit: "A", multiplier: 0.1, semantic: "string_current" },
];

/**
 * Applies the approved TRN246 / ana register table supplied for this plant.
 * The source payload stays available through raw_data and source_raw_value;
 * only the customer-facing data field becomes an approved engineering value.
 */
export function applyTrn246TelemetryCalibration(parameter: Record<string, unknown>) {
  if (sourceOf(parameter) !== "ana") return parameter;

  const parameterName = normalized(parameter.name ?? parameter.parameter ?? parameter.tag);
  const address = addressOf(parameter);
  const calibration = TRN246_CALIBRATIONS.find((entry) => entry.parameter === parameterName && entry.address === address);
  const rawValue = numericValue(parameter.data ?? parameter.value ?? parameter.currentValue ?? parameter.current_value);

  if (calibration && rawValue !== undefined) {
    return {
      ...parameter,
      data: rawValue * calibration.multiplier,
      raw_data: parameter.raw_data ?? rawValue,
      source_raw_value: rawValue,
      engineering_value: rawValue * calibration.multiplier,
      engineering_unit: calibration.unit,
      unit: calibration.unit,
      display_name: calibration.displayName,
      semantic: calibration.semantic,
      measurement_type: calibration.semantic,
      scaling_validated: true,
      engineering_value_validated: true,
      scaling_status: "validated",
      calibration_source: "Approved TRN246 SCADA parameter mapping",
    };
  }

  // The approved mapping identifies 305003 invN rows as inverter identity
  // metadata. They are deliberately not eligible for power or energy totals.
  const inverterIdentity = parameterName.match(/^inv([1-5])$/);
  if (inverterIdentity && address === "305003") {
    return {
      ...parameter,
      display_name: `Inverter ${inverterIdentity[1]} identity`,
      semantic: "inverter_identity",
      measurement_type: "inverter_identity",
      calibration_source: "Approved TRN246 SCADA parameter mapping",
      calibration_note: "Identity register; not an active-power or energy measurement.",
    };
  }

  return parameter;
}