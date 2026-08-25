import type { PlatformTelemetryDestination } from "@workspace/api-client-react";

export type TelemetryMappingGuidance = {
  recommendedLabel: string;
  recommendedCategory: string;
  frontEndDisplay: string;
  explanation: string;
  unitSuggestions: string[];
  unitless: boolean;
};

const unitlessDestinations = new Set<PlatformTelemetryDestination>([
  "inverter-identity",
  "alarm",
  "fault",
  "communication",
  "data-quality",
]);

function environmentalUnitSuggestions(parameterName: string) {
  const normalized = parameterName.toLowerCase();
  if (/(irradiance|radiation|w\/m2|wm2)/.test(normalized)) return ["W/m²"];
  if (/(humidity|relative humidity)/.test(normalized)) return ["%"];
  if (/(wind.*speed|windspeed)/.test(normalized)) return ["m/s", "km/h"];
  if (/(temperature|temp|ambient|module|cell)/.test(normalized)) return ["°C", "°F"];
  return ["°C", "%", "W/m²", "m/s"];
}

export function isUnitlessTelemetryDestination(destination: PlatformTelemetryDestination) {
  return unitlessDestinations.has(destination);
}

export function telemetryMappingGuidance(
  destination: PlatformTelemetryDestination,
  parameterName: string,
  sourceUnit: string | null | undefined,
): TelemetryMappingGuidance {
  const suggested = (unitSuggestions: string[]) => [...new Set([sourceUnit?.trim(), ...unitSuggestions].filter((unit): unit is string => Boolean(unit)))];
  switch (destination) {
    case "inverter-identity":
      return { recommendedLabel: "Inverter identity", recommendedCategory: "Overview", frontEndDisplay: "Inverter identification and device detail", explanation: "Use only a source tag that explicitly identifies one physical inverter.", unitSuggestions: [], unitless: true };
    case "active-power":
      return { recommendedLabel: "AC active power", recommendedCategory: "Electrical", frontEndDisplay: "Inverters, power distribution, and electrical trend views", explanation: "Choose the physical inverter and confirm the reported power unit before using this source.", unitSuggestions: suggested(["W", "kW", "MW"]), unitless: false };
    case "daily-energy":
      return { recommendedLabel: "Daily energy", recommendedCategory: "Energy", frontEndDisplay: "Energy Analytics and daily production views", explanation: "Use a source-reported daily counter; this does not integrate instantaneous power.", unitSuggestions: suggested(["Wh", "kWh", "MWh"]), unitless: false };
    case "total-energy":
      return { recommendedLabel: "Total energy", recommendedCategory: "Energy", frontEndDisplay: "Energy Analytics and cumulative production views", explanation: "Use a source-reported cumulative counter only.", unitSuggestions: suggested(["Wh", "kWh", "MWh"]), unitless: false };
    case "specific-yield":
      return { recommendedLabel: "Specific yield", recommendedCategory: "Energy", frontEndDisplay: "Energy Analytics yield view", explanation: "Use only a source value whose yield basis is explicitly known.", unitSuggestions: suggested(["kWh/kWp"]), unitless: false };
    case "voltage":
      return { recommendedLabel: "AC voltage", recommendedCategory: "Electrical", frontEndDisplay: "Electrical parameters and inverter detail", explanation: "Map a voltage signal only after confirming its reported unit.", unitSuggestions: suggested(["V", "kV", "mV"]), unitless: false };
    case "current":
      return { recommendedLabel: "AC current", recommendedCategory: "Electrical", frontEndDisplay: "Electrical parameters and inverter detail", explanation: "Map a current signal only after confirming its reported unit.", unitSuggestions: suggested(["A", "mA", "kA"]), unitless: false };
    case "frequency":
      return { recommendedLabel: "Grid frequency", recommendedCategory: "Electrical", frontEndDisplay: "Electrical parameters and inverter detail", explanation: "Map a frequency signal only after confirming its reported unit.", unitSuggestions: suggested(["Hz", "kHz"]), unitless: false };
    case "environmental":
      return { recommendedLabel: "Environmental measurement", recommendedCategory: "Overview", frontEndDisplay: "Environment and plant overview context", explanation: "Select a unit that is explicitly confirmed by the device documentation or source payload.", unitSuggestions: suggested(environmentalUnitSuggestions(parameterName)), unitless: false };
    case "alarm":
      return { recommendedLabel: "Alarm status", recommendedCategory: "Alarms / Faults", frontEndDisplay: "Alarms & Events and source evidence", explanation: "Alarm states are unitless source evidence and are not converted into an engineering value.", unitSuggestions: [], unitless: true };
    case "fault":
      return { recommendedLabel: "Fault code", recommendedCategory: "Alarms / Faults", frontEndDisplay: "Alarms & Events and source evidence", explanation: "Fault codes are unitless source evidence; retain the raw code and source reason.", unitSuggestions: [], unitless: true };
    case "communication":
      return { recommendedLabel: "Communication status", recommendedCategory: "Communication", frontEndDisplay: "Communication health and event evidence", explanation: "Communication states are unitless source evidence.", unitSuggestions: [], unitless: true };
    case "data-quality":
      return { recommendedLabel: "Data quality status", recommendedCategory: "Communication", frontEndDisplay: "Data quality and source evidence", explanation: "Quality states are unitless source evidence.", unitSuggestions: [], unitless: true };
    case "discovered-other":
    default:
      return { recommendedLabel: parameterName || "Discovered parameter", recommendedCategory: "Discovered / Other Parameters", frontEndDisplay: "Live Data and parameter discovery only", explanation: "Keep unknown telemetry in discovery until its semantic meaning and unit are confirmed.", unitSuggestions: suggested([]), unitless: false };
  }
}