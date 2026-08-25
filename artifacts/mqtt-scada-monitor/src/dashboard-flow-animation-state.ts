import type { InverterFlowMode, InverterFlowProvenance } from './inverter-flow-state';

export type DashboardMonitoringStatus = 'live' | 'stale' | 'interrupted' | 'awaiting-first-data';

export function dashboardFlowAnimationState({
  mode,
  monitoringStatus,
  provenance,
  streaming,
  rawLiveTelemetry,
}: {
  mode: InverterFlowMode;
  monitoringStatus: DashboardMonitoringStatus;
  provenance?: InverterFlowProvenance;
  streaming: boolean;
  rawLiveTelemetry: boolean;
}) {
  const monitoringChannelActive = mode === 'demo' || (mode === 'live' && monitoringStatus !== 'interrupted' && provenance !== 'snapshot');
  const movement = streaming ? 'power' : monitoringChannelActive ? 'monitoring' : 'paused';
  const statusTone = provenance === 'snapshot'
    ? 'saved'
    : rawLiveTelemetry
      ? 'raw'
      : streaming
        ? 'active'
        : monitoringChannelActive
          ? 'monitoring'
          : 'paused';

  return { monitoringChannelActive, movement, statusTone };
}