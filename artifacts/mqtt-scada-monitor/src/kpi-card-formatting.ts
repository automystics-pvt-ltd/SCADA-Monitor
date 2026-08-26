import type { RawTelemetryMetric, VerifiedKpiCalculation } from './telemetry-kpis.ts';
import { formatInPlantTimezone } from './plant-timezone.ts';

export type RawKpiFallback = {
  value: number | null;
  unit: string;
  formula: string;
  method: string;
  inputs: RawTelemetryMetric[];
  readiness: string;
  sourceUnit?: string;
};

/**
 * Shared KPI card formatting. The live dashboard and the saved-only
 * Overview pipeline both turn a verified calculation (or, failing that, a
 * raw fallback) into the same {value, unit, details} shape -- the only
 * difference is which "last saved" context they show when nothing is
 * verified and no raw value was reported. Keeping this in one place means a
 * future formatting change (e.g. rounding, wording) can't apply to only one
 * pipeline by accident.
 */
export function calculationValue(calculation: VerifiedKpiCalculation) {
  return calculation.quality === 'verified' ? calculation.value!.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
}

export function calculationUnit(calculation: VerifiedKpiCalculation) {
  return calculation.quality === 'verified' ? calculation.unit ?? '' : '';
}

export function calculationContext(calculation: VerifiedKpiCalculation, timezone: string | undefined) {
  if (calculation.quality !== 'verified') return calculation.readiness;
  const outliers = calculation.excluded.length ? ` · ${calculation.excluded.length} outlier${calculation.excluded.length === 1 ? '' : 's'} excluded` : '';
  const saved = calculation.snapshotWindow ? ` · saved ${formatInPlantTimezone(calculation.snapshotWindow.capturedAt, timezone)}` : '';
  return `${calculation.method.replaceAll('-', ' ')} · ${calculation.inputs.length} approved source input${calculation.inputs.length === 1 ? '' : 's'} · ${calculation.profileVersion}${outliers}${saved}`;
}

export type KpiCard = { value: string; unit: string; details: string };

export type KpiCardContext = {
  timezone: string | undefined;
  hasSavedRecord: boolean;
  savedLabel: string | undefined;
};

export function buildCalculationCard(calculation: VerifiedKpiCalculation, rawFallback: RawKpiFallback, context: KpiCardContext): KpiCard {
  if (calculation.quality === 'verified') {
    return {
      value: calculationValue(calculation),
      unit: calculationUnit(calculation),
      details: `${calculation.formula}. ${calculationContext(calculation, context.timezone)}`,
    };
  }
  if (rawFallback.value === null) {
    return {
      value: 'Not reported',
      unit: '',
      details: context.hasSavedRecord ? `${rawFallback.readiness} Last saved: ${context.savedLabel}.` : rawFallback.readiness,
    };
  }
  const registerList = rawFallback.inputs.map((input) => `${input.parameter} (${input.address})`).join(' + ');
  return {
    value: rawFallback.value.toLocaleString(undefined, { maximumFractionDigits: 4 }),
    unit: rawFallback.unit,
    details: `${rawFallback.formula}. Source: ${registerList}${rawFallback.sourceUnit ? ` (${rawFallback.sourceUnit})` : ''}. ${rawFallback.inputs.some((input) => input.sourceReported) ? 'Source-reported; engineering scaling is not confirmed.' : 'Engineering scaling is not confirmed.'}${context.hasSavedRecord ? ` Last saved: ${context.savedLabel}.` : ''}`,
  };
}
