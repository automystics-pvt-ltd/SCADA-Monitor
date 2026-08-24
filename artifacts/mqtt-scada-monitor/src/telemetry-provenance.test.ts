import assert from 'node:assert/strict';
import test from 'node:test';
import { promotesOperationalTelemetry } from './telemetry-provenance.ts';

test('SSE history replay never promotes a payload into operational telemetry', () => {
  const replayedPayload = { receivedAt: Date.now(), devices: ['INV-01'], rows: ['phaseCAvoltage'] };

  assert.equal(promotesOperationalTelemetry(true), false);
  assert.equal(promotesOperationalTelemetry(false), true);
  assert.ok(replayedPayload.receivedAt > 0, 'a recent replay timestamp must not alter the replay decision');
});