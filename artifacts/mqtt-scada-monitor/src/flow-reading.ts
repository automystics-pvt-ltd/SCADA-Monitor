import type { VerifiedKpiCalculation } from './telemetry-kpis.ts';

/**
 * Shared shape for the Dashboard power-flow reading. Both the live
 * dashboard (which may show a live, replayed, or last-saved validated
 * calculation) and the saved-only Overview pipeline (which only ever shows
 * a last-saved validated calculation) build this exact object whenever the
 * AC-power calculation is "verified" -- only the live/saved classification
 * and which timestamp to show differ between the two call sites.
 */
export type FlowReading = {
  value: number | null;
  unit: string;
  quality: 'reported' | 'unavailable';
  provenance?: 'live' | 'snapshot' | 'replay';
  status: 'online' | 'stale' | 'offline';
  sourceLabel: string;
  observedAt?: string;
  observationLabel?: string;
  inverterCount?: number;
};

export type VerifiedFlowReadingContext = {
  /** True when the calculation's inputs are confirmed live and fresh right now. */
  live: boolean;
  /** True when the calculation is being read from a saved backend snapshot. */
  saved: boolean;
  /** Timestamp to report when `saved` is true. */
  savedSnapshotTime?: string;
  /** Timestamp to report when neither `live` nor `saved` classify the reading (falls back to the calculation's own `calculatedAt`). */
  observedAt?: string;
};

export function buildVerifiedAcPowerFlowReading(acPower: VerifiedKpiCalculation, context: VerifiedFlowReadingContext): FlowReading {
  const { live, saved, savedSnapshotTime, observedAt } = context;
  return {
    value: acPower.value,
    unit: acPower.unit ?? '',
    quality: acPower.value === null ? 'unavailable' : 'reported',
    provenance: live ? 'live' : saved ? 'snapshot' : acPower.provenance === 'replay' ? 'replay' : undefined,
    status: live ? 'online' : 'stale',
    sourceLabel: `${live ? 'Validated live' : saved ? 'Last saved validated' : 'Validated historical'} · ${acPower.profileVersion}`,
    observedAt: saved ? savedSnapshotTime : observedAt ?? acPower.calculatedAt,
    observationLabel: saved ? 'Saved snapshot' : acPower.inputs.length > 1 ? 'Contributing timestamps' : 'Observed',
    inverterCount: acPower.method === 'inverter-sum' ? acPower.inputs.length : undefined,
  };
}

export type UnverifiedSavedFlowReadingContext = {
  /** True when a saved backend record exists at all (whether or not it carries raw power evidence). */
  hasSavedRecord: boolean;
  /** True when the saved record carries a raw power reading that simply lacks an approved engineering mapping. */
  hasRawEvidence: boolean;
  /** Timestamp of the saved snapshot, when one exists. */
  savedSnapshotTime?: string;
};

/**
 * Shared fallback for the AC-power flow reading when there is no verified
 * calculation to show and the panel is displaying saved (not live) evidence.
 * Distinguishes three cases so the label never implies evidence that isn't
 * there: unmapped raw evidence present in the saved record, a saved record
 * with no power evidence at all, and no saved record at all.
 */
export function buildUnverifiedSavedAcPowerFlowReading(context: UnverifiedSavedFlowReadingContext): FlowReading {
  const { hasSavedRecord, hasRawEvidence, savedSnapshotTime } = context;
  if (hasRawEvidence) {
    return {
      value: null,
      unit: '',
      quality: 'unavailable',
      provenance: 'snapshot',
      status: 'stale',
      sourceLabel: 'Saved raw power evidence · approved engineering mapping required',
      observedAt: savedSnapshotTime,
      observationLabel: 'Saved snapshot evidence',
    };
  }
  return {
    value: null,
    unit: '',
    quality: 'unavailable',
    provenance: hasSavedRecord ? 'snapshot' : undefined,
    status: 'offline',
    sourceLabel: hasSavedRecord ? 'No approved active-power evidence in the saved record' : 'No saved backend record yet',
    observedAt: savedSnapshotTime,
    observationLabel: 'Saved snapshot',
  };
}
