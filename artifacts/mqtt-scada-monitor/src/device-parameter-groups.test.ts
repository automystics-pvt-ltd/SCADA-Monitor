import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceParameterPresentation, groupDeviceParameters, parseDeviceParameters } from './device-parameter-groups.ts';

const rawParameter = {
  observationId: 'parameter:raw',
  signalKey: 'site|inv-1|channel|1',
  siteName: 'TRN246',
  deviceId: 'inv-1',
  deviceName: 'Inverter 1',
  topic: 'trn246/modbus',
  originalName: 'channel_1',
  normalizedName: 'channel1',
  displayLabel: 'Channel 1',
  category: 'unexpected',
  rawValue: 'enabled',
  value: null,
  unit: null,
  address: '40001',
  sourceName: 'PLC 1',
  receivedAt: '2026-08-25T09:00:05.000Z',
  provenance: 'recovered',
  dataQuality: 'source-reported',
  scalingStatus: 'raw',
  freshness: 'recovered',
};

test('keeps unknown/non-numeric source evidence visible in discovered other parameters', () => {
  const parameters = parseDeviceParameters([rawParameter]);
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0]?.category, 'Discovered / Other Parameters');
  assert.equal(parameters[0]?.value, null);
  assert.equal(parameters[0]?.freshness, 'recovered');
});

test('groups source-backed parameters in a stable operational order without promoting raw values', () => {
  const parameters = parseDeviceParameters([
    rawParameter,
    {
      ...rawParameter,
      observationId: 'parameter:voltage',
      category: 'Electrical',
      displayLabel: 'DC Voltage',
      rawValue: '701',
      value: 701,
      unit: 'V',
      provenance: 'live',
      dataQuality: 'raw',
      freshness: 'stale',
    },
    {
      ...rawParameter,
      observationId: 'parameter:energy',
      category: 'Energy',
      displayLabel: 'Daily Energy',
      rawValue: '123.4',
      value: 123.4,
      unit: 'kWh',
      dataQuality: 'validated',
      scalingStatus: 'validated',
      provenance: 'snapshot',
      freshness: 'saved',
    },
  ]);
  const grouped = groupDeviceParameters(parameters);
  assert.deepEqual(grouped.map(([category]) => category), ['Electrical', 'Energy', 'Discovered / Other Parameters']);
  assert.equal(grouped[0]?.[1][0]?.scalingStatus, 'raw');
  assert.equal(grouped[1]?.[1][0]?.freshness, 'saved');
});

test('never presents saved, recovered, or stale values as validated live engineering data', () => {
  const [saved] = parseDeviceParameters([{
    ...rawParameter,
    category: 'Energy',
    rawValue: '123.4',
    value: 123.4,
    unit: 'kWh',
    provenance: 'snapshot',
    dataQuality: 'validated',
    scalingStatus: 'validated',
    freshness: 'saved',
  }]);
  const [stale] = parseDeviceParameters([{
    ...rawParameter,
    value: 701,
    unit: 'V',
    provenance: 'live',
    dataQuality: 'validated',
    scalingStatus: 'validated',
    freshness: 'stale',
  }]);
  assert.equal(deviceParameterPresentation(saved!).isValidatedLive, false);
  assert.match(deviceParameterPresentation(saved!).title, /not live/);
  assert.equal(deviceParameterPresentation(stale!).isValidatedLive, false);
});