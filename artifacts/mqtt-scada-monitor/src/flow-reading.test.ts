import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVerifiedAcPowerFlowReading } from './flow-reading.ts';
import type { VerifiedKpiCalculation } from './telemetry-kpis.ts';

function verifiedAcPower(overrides: Partial<VerifiedKpiCalculation> = {}): VerifiedKpiCalculation {
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

test('a live reading reports online status and the live provenance', () => {
  const reading = buildVerifiedAcPowerFlowReading(verifiedAcPower(), { live: true, saved: false, observedAt: '2026-08-26T05:00:00.000Z' });
  assert.equal(reading.status, 'online');
  assert.equal(reading.provenance, 'live');
  assert.match(reading.sourceLabel, /^Validated live/);
  assert.equal(reading.observedAt, '2026-08-26T05:00:00.000Z');
});

test('a saved reading reports stale status, the snapshot provenance, and the saved snapshot timestamp', () => {
  const reading = buildVerifiedAcPowerFlowReading(verifiedAcPower(), { live: false, saved: true, savedSnapshotTime: '2026-08-26T04:45:00.000Z' });
  assert.equal(reading.status, 'stale');
  assert.equal(reading.provenance, 'snapshot');
  assert.match(reading.sourceLabel, /^Last saved validated/);
  assert.equal(reading.observedAt, '2026-08-26T04:45:00.000Z');
  assert.equal(reading.observationLabel, 'Saved snapshot');
});

test('neither live nor saved falls back to the calculation replay provenance and its own calculatedAt', () => {
  const reading = buildVerifiedAcPowerFlowReading(verifiedAcPower({ provenance: 'replay' }), { live: false, saved: false });
  assert.equal(reading.status, 'stale');
  assert.equal(reading.provenance, 'replay');
  assert.equal(reading.observedAt, '2026-08-26T05:00:00.000Z');
});

test('inverterCount is only populated for the inverter-sum method', () => {
  const summed = buildVerifiedAcPowerFlowReading(verifiedAcPower({ method: 'inverter-sum' }), { live: true, saved: false });
  assert.equal(summed.inverterCount, 1);

  const mainMeter = buildVerifiedAcPowerFlowReading(verifiedAcPower({ method: 'main-meter' }), { live: true, saved: false });
  assert.equal(mainMeter.inverterCount, undefined);
});

test('an unverified value is reported as unavailable quality', () => {
  const reading = buildVerifiedAcPowerFlowReading(verifiedAcPower({ value: null }), { live: true, saved: false });
  assert.equal(reading.quality, 'unavailable');
});
