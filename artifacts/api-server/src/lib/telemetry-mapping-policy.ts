const unitlessMappingDestinations = new Set([
  "inverter-identity",
  "alarm",
  "fault",
  "communication",
  "data-quality",
]);

/**
 * Unitless source states are useful in SCADA evidence and must not be blocked
 * merely because a device reports them as a number or omits a unit.
 */
export function telemetryMappingRequiresDisplayUnit(destination: string) {
  return !unitlessMappingDestinations.has(destination);
}