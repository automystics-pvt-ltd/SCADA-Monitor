import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardFlowAnimationState } from './dashboard-flow-animation-state.ts';

test('keeps a dim monitoring animation running while live telemetry awaits fresh power', () => {
  const state = dashboardFlowAnimationState({
    mode: 'live',
    monitoringStatus: 'stale',
    provenance: 'live',
    streaming: false,
    rawLiveTelemetry: false,
  });

  assert.deepEqual(state, {
    monitoringChannelActive: true,
    movement: 'monitoring',
    statusTone: 'monitoring',
  });
});

test('stops dashboard flow movement for confirmed interruptions and saved evidence', () => {
  const interrupted = dashboardFlowAnimationState({
    mode: 'live',
    monitoringStatus: 'interrupted',
    provenance: 'live',
    streaming: false,
    rawLiveTelemetry: false,
  });
  const saved = dashboardFlowAnimationState({
    mode: 'live',
    monitoringStatus: 'live',
    provenance: 'snapshot',
    streaming: false,
    rawLiveTelemetry: false,
  });

  assert.equal(interrupted.movement, 'paused');
  assert.equal(saved.movement, 'paused');
});