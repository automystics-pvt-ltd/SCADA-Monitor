/**
 * Replay events are evidence from a previous SSE session, never new MQTT
 * observations. They may be shown in the raw inspector but cannot promote
 * operational state.
 */
export function promotesOperationalTelemetry(replay: boolean) {
  return !replay;
}