import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInverterSourceDevice, findLatestInverterSourceRow } from './inverter-source-devices.ts';

const NOW = Date.parse('2026-08-26T05:10:00.000Z');

const signal = {
  parameter: 'inv1',
  value: 3977,
  address: '305003',
  provenance: 'live' as const,
  sourceName: 'ana',
  inverterId: 'inv1',
  observedAt: '2026-08-26T05:09:30.000Z',
};

const matchingRow = {
  server_name: 'ana',
  name: 'inv1',
  full_addr: '305003',
  inverter_id: 'inv1',
  date_iso_8601: '2026-08-26T05:09:30.000Z',
  value: 3977,
};

test('findLatestInverterSourceRow picks the newest row matching source identity', () => {
  const older = { ...matchingRow, date_iso_8601: '2026-08-26T05:00:00.000Z' };
  const row = findLatestInverterSourceRow([older, matchingRow], signal);
  assert.equal(row, matchingRow);
});

test('findLatestInverterSourceRow ignores rows for a different inverter id', () => {
  const otherInverter = { ...matchingRow, inverter_id: 'inv2' };
  const row = findLatestInverterSourceRow([otherInverter], signal);
  assert.equal(row, undefined);
});

test('buildInverterSourceDevice classifies status from the caller-supplied reporting state', () => {
  const liveDevice = buildInverterSourceDevice(signal, [matchingRow], {
    site: 'Plant A',
    now: NOW,
    reportingState: () => 'live',
  });
  assert.equal(liveDevice.status, 'online');
  assert.equal(liveDevice.sourceEvidence.reportingState, 'live');

  const savedDevice = buildInverterSourceDevice(signal, [matchingRow], {
    site: 'Plant A',
    now: NOW,
    reportingState: () => 'saved',
  });
  assert.equal(savedDevice.status, 'stale');
  assert.equal(savedDevice.sourceEvidence.reportingState, 'saved');
});

test('buildInverterSourceDevice carries the matched evidence row and identity through', () => {
  const device = buildInverterSourceDevice(signal, [matchingRow], {
    site: 'Plant A',
    now: NOW,
    reportingState: () => 'stale',
  });
  assert.equal(device.id, `source-${encodeURIComponent('ana|inverter:inv1')}`);
  assert.equal(device.name, 'inv1');
  assert.equal(device.energyInverterId, 'inv1');
  assert.equal(device.site, 'Plant A');
  assert.deepEqual(device.telemetry.raw_modbus_row, matchingRow);
  assert.equal(device.telemetry.source_tag.parameter, 'inv1');
});

test('buildInverterSourceDevice falls back to signal.observedAt and "Unavailable" lastSeen handling when no row matches', () => {
  const device = buildInverterSourceDevice(signal, [], {
    site: 'Plant A',
    now: NOW,
    reportingState: () => 'stale',
  });
  assert.equal(device.telemetry.raw_modbus_row, undefined);
  assert.equal(device.sourceEvidence.observedAt, signal.observedAt);
  assert.equal(device.lastSeen, Date.parse(signal.observedAt));
});

test('buildInverterSourceDevice marks identity-only signals with the inverter-identity semantic', () => {
  const identitySignal = { ...signal, parameter: 'inv1', signalKind: 'identity' as const };
  const device = buildInverterSourceDevice(identitySignal, [], {
    site: 'Plant A',
    now: NOW,
    reportingState: () => 'stale',
  });
  assert.equal(device.sourceEvidence.semantic, 'inverter-identity');
});
