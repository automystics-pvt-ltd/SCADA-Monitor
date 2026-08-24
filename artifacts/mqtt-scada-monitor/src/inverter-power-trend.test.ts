import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPowerTrendSeries, countRawPowerSamples, getPowerTrendState, selectValidatedPowerSamples } from './inverter-power-trend.ts';

const baseSample = {
  id: 1,
  unit: 'kW',
  observedAt: '2026-08-24T10:00:00.000Z',
  receivedAt: '2026-08-24T10:00:01.000Z',
  parameter: 'active_power',
  sourceName: 'Inverter archive',
  address: '305040',
};

test('selects only explicitly validated AC/DC power for the trend', () => {
  const samples = [
    { ...baseSample, measurementKind: 'active-power', scalingStatus: 'validated', value: 12.5 },
    { ...baseSample, id: 2, measurementKind: 'dc-power', scalingStatus: 'validated', value: 14.1 },
    { ...baseSample, id: 3, measurementKind: 'active-power', scalingStatus: 'raw', value: 99 },
    { ...baseSample, id: 4, measurementKind: 'electrical', scalingStatus: 'validated', value: 230 },
  ];

  assert.equal(selectValidatedPowerSamples(samples).length, 2);
  assert.equal(countRawPowerSamples(samples), 1);
  assert.equal(getPowerTrendState(samples), 'validated');
});

test('keeps AC and DC as separate series and preserves duplicate same-signal samples', () => {
  const samples = [
    { ...baseSample, id: 1, measurementKind: 'active-power', scalingStatus: 'validated', value: 12.5 },
    { ...baseSample, id: 2, measurementKind: 'dc-power', scalingStatus: 'validated', value: 14.1 },
    { ...baseSample, id: 3, measurementKind: 'active-power', scalingStatus: 'validated', value: 13.2 },
  ];

  const series = buildPowerTrendSeries(samples);
  assert.equal(series.length, 2);
  assert.equal(series[0]?.ac, 12.5);
  assert.equal(series[0]?.dc, 14.1);
  assert.equal(series[1]?.ac, 13.2);
  assert.match(series[0]?.time ?? '', /Aug|24/);
});

test('classifies raw-only and unavailable power history honestly', () => {
  const raw = [{ ...baseSample, measurementKind: 'active-power', scalingStatus: 'raw', value: 120 }];
  assert.equal(getPowerTrendState(raw), 'raw-only');
  assert.equal(buildPowerTrendSeries(raw).length, 0);
  assert.equal(getPowerTrendState([]), 'unavailable');
  assert.equal(getPowerTrendState([], true), 'loading');
});