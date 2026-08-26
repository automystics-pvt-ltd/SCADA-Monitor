import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCalculationCard, calculationContext, calculationUnit, calculationValue, type KpiCardContext, type RawKpiFallback } from './kpi-card-formatting.ts';
import type { VerifiedKpiCalculation } from './telemetry-kpis.ts';

const context: KpiCardContext = { timezone: 'UTC', hasSavedRecord: true, savedLabel: '26 Aug, 05:00' };

function verifiedCalculation(overrides: Partial<VerifiedKpiCalculation> = {}): VerifiedKpiCalculation {
  return {
    key: 'acPower',
    label: 'AC Power',
    value: 512.4,
    unit: 'kW',
    quality: 'verified',
    method: 'inverter-sum',
    formula: 'Sum of approved inverter AC power registers',
    inputs: [{ parameter: 'inv1', value: 512.4, address: '305031', provenance: 'live', unit: 'kW', semantic: 'ac-power' }],
    excluded: [],
    calculatedAt: '2026-08-26T05:00:00.000Z',
    provenance: 'live',
    profileVersion: 'plant-calibration-required-v1',
    readiness: 'ready',
    ...overrides,
  } as VerifiedKpiCalculation;
}

const rawFallback: RawKpiFallback = {
  value: null,
  unit: '',
  formula: '',
  method: '',
  inputs: [],
  readiness: 'Awaiting an approved power mapping.',
};

test('calculationValue/calculationUnit only report a number for verified calculations', () => {
  const verified = verifiedCalculation();
  assert.equal(calculationValue(verified), '512.4');
  assert.equal(calculationUnit(verified), 'kW');

  const unverified = verifiedCalculation({ quality: 'unavailable', value: null, unit: null });
  assert.equal(calculationValue(unverified), '—');
  assert.equal(calculationUnit(unverified), '');
});

test('calculationContext reports readiness text for a non-verified calculation', () => {
  const unverified = verifiedCalculation({ quality: 'unavailable', readiness: 'No approved mapping yet.' });
  assert.equal(calculationContext(unverified, 'UTC'), 'No approved mapping yet.');
});

test('calculationContext includes excluded-outlier and saved-snapshot detail when present', () => {
  const verified = verifiedCalculation({
    excluded: [{ parameter: 'inv9', value: 99999, address: '305099', provenance: 'live', unit: 'kW', semantic: 'ac-power' }],
    snapshotWindow: { startedAt: 'a', endedAt: 'b', scheduledFor: 'c', capturedAt: '2026-08-26T05:00:00.000Z' },
  });
  const text = calculationContext(verified, 'UTC');
  assert.match(text, /1 outlier excluded/);
  assert.match(text, /saved/);
});

test('buildCalculationCard returns the formatted value/unit/details for a verified calculation', () => {
  const card = buildCalculationCard(verifiedCalculation(), rawFallback, context);
  assert.equal(card.value, '512.4');
  assert.equal(card.unit, 'kW');
  assert.match(card.details, /Sum of approved inverter AC power registers/);
});

test('buildCalculationCard reports "Not reported" with the saved label when nothing was ever reported', () => {
  const unverified = verifiedCalculation({ quality: 'unavailable', value: null, unit: null });
  const card = buildCalculationCard(unverified, rawFallback, context);
  assert.equal(card.value, 'Not reported');
  assert.match(card.details, /Last saved: 26 Aug, 05:00/);
});

test('buildCalculationCard falls back to the raw evidence value when unverified but reported', () => {
  const unverified = verifiedCalculation({ quality: 'unavailable', value: null, unit: null });
  const fallbackWithValue: RawKpiFallback = {
    value: 480.2,
    unit: 'kW',
    formula: 'Raw active power register',
    method: 'raw-metric',
    inputs: [{ parameter: 'actpow', value: 480.2, address: '305031', provenance: 'live', sourceReported: true }],
    readiness: 'Scaling not confirmed.',
  };
  const card = buildCalculationCard(unverified, fallbackWithValue, context);
  assert.equal(card.value, '480.2');
  assert.equal(card.unit, 'kW');
  assert.match(card.details, /Source-reported; engineering scaling is not confirmed\./);
  assert.match(card.details, /Last saved: 26 Aug, 05:00/);
});

test('buildCalculationCard omits the saved-label sentence when hasSavedRecord is false', () => {
  const unverified = verifiedCalculation({ quality: 'unavailable', value: null, unit: null });
  const card = buildCalculationCard(unverified, rawFallback, { ...context, hasSavedRecord: false });
  assert.doesNotMatch(card.details, /Last saved/);
});
