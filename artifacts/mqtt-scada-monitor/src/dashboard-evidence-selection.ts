export type DashboardLiveState = 'fresh' | 'stale' | 'unavailable';
export type DashboardEvidenceSelection = 'live' | 'saved' | 'none';

/**
 * A confirmed saved snapshot is a fallback for an unavailable live channel,
 * never a permanent replacement for fresh direct telemetry.
 */
export function selectDashboardEvidenceSource({
  mode,
  liveState,
  hasSavedEvidence,
}: {
  mode: 'demo' | 'live';
  liveState: DashboardLiveState;
  hasSavedEvidence: boolean;
}): DashboardEvidenceSelection {
  if (mode === 'demo' || liveState === 'fresh') return 'live';
  return hasSavedEvidence ? 'saved' : 'none';
}