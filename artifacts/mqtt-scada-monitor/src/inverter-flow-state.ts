export type InverterFlowQuality = 'reported' | 'raw' | 'unavailable';
export type InverterFlowStatus = 'online' | 'stale' | 'offline';
export type InverterFlowMode = 'demo' | 'live';
export type InverterFlowProvenance = 'live' | 'retained' | 'recovered' | 'replay' | undefined;

export function inverterFlowState({
  value,
  quality,
  status,
  mode,
  provenance,
}: {
  value: number | null;
  quality: InverterFlowQuality;
  status: InverterFlowStatus;
  mode: InverterFlowMode;
  provenance?: InverterFlowProvenance;
}) {
  const liveSourceTag = mode === 'live' && provenance === 'live';
  const streaming = value !== null && value > 0 && quality !== 'unavailable' && (status === 'online' || (liveSourceTag && status !== 'offline'));
  const rawLiveTelemetry = liveSourceTag && quality === 'raw' && streaming;
  const statusLabel = quality === 'raw'
    ? `${rawLiveTelemetry ? 'Live raw telemetry stream' : mode === 'live' ? 'Raw source tag' : 'Raw source stream'} · scaling required`
    : value === null
      ? 'No reported power value'
      : streaming
        ? mode === 'live' ? 'Live broker power stream' : 'Reported power flow'
        : 'Flow paused until fresh inverter telemetry';

  return { streaming, rawLiveTelemetry, statusLabel };
}