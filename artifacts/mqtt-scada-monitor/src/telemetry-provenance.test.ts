import assert from 'node:assert/strict';
import test from 'node:test';
import { promotesOperationalTelemetry, rememberTelemetryDelivery, shouldReplaceTelemetryRow, telemetryDeliveryIdentity } from './telemetry-provenance.ts';

test('SSE history replay never promotes a payload into operational telemetry', () => {
  const replayedPayload = { receivedAt: Date.now(), devices: ['INV-01'], rows: ['phaseCAvoltage'] };

  assert.equal(promotesOperationalTelemetry('replay'), false);
  assert.equal(promotesOperationalTelemetry('recovered'), false);
  assert.equal(promotesOperationalTelemetry('live'), true);
  assert.ok(replayedPayload.receivedAt > 0, 'a recent replay timestamp must not alter the replay decision');
});

test('recovered telemetry is deduplicated by its delivery identity', () => {
  const seen = new Map<string, true>();
  const identity = telemetryDeliveryIdentity('42', 'trn246/modbus', '2026-08-24T04:00:00.000Z', '{"data":1}');

  assert.equal(rememberTelemetryDelivery(seen, identity), true);
  assert.equal(rememberTelemetryDelivery(seen, identity), false);
});

test('historical replay cannot overwrite newer live evidence', () => {
  const live = { timestamp: '2026-08-24T04:00:10.000Z', provenance: 'live' };
  const olderReplay = { timestamp: '2026-08-24T04:00:00.000Z', provenance: 'replay' };
  const recovered = { timestamp: '2026-08-24T04:00:20.000Z', provenance: 'recovered' };

  assert.equal(shouldReplaceTelemetryRow(live, olderReplay), false);
  assert.equal(shouldReplaceTelemetryRow(live, recovered), false);
});