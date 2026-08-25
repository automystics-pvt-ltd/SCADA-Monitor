import assert from 'node:assert/strict';
import test from 'node:test';
import { inverterFlowState } from './inverter-flow-state.ts';

test('streams fresh live broker power without relabeling raw evidence as engineering data', () => {
  const rawLive = inverterFlowState({ value: 10494, quality: 'raw', status: 'online', mode: 'live', provenance: 'live' });
  const validatedLive = inverterFlowState({ value: 4030.9, quality: 'reported', status: 'online', mode: 'live', provenance: 'live' });

  assert.equal(rawLive.streaming, true);
  assert.equal(rawLive.rawLiveTelemetry, true);
  assert.match(rawLive.statusLabel, /Live raw telemetry stream.*scaling required/i);
  assert.equal(validatedLive.streaming, true);
  assert.match(validatedLive.statusLabel, /Live broker power stream/i);
});

test('pauses a live source when telemetry freshness expires', () => {
  const staleLive = inverterFlowState({ value: 10494, quality: 'reported', status: 'stale', mode: 'live', provenance: 'live' });

  assert.equal(staleLive.streaming, false);
  assert.match(staleLive.statusLabel, /paused/i);
});

test('does not turn retained, recovered, replayed, or unmapped source tags into a live stream', () => {
  for (const provenance of ['retained', 'recovered', 'replay', undefined] as const) {
    assert.equal(inverterFlowState({ value: 10494, quality: 'raw', status: 'online', mode: 'live', provenance }).streaming, false);
  }
});

test('preserves a saved positive value without animating it as live', () => {
  const saved = inverterFlowState({ value: 10494, quality: 'reported', status: 'online', mode: 'live', provenance: 'snapshot' });

  assert.equal(saved.streaming, false);
  assert.match(saved.statusLabel, /saved power record/i);
});

test('pauses the inverter flow for unavailable, stale, offline, or zero telemetry', () => {
  for (const source of [
    { value: null, quality: 'unavailable' as const, status: 'online' as const },
    { value: 100, quality: 'reported' as const, status: 'stale' as const },
    { value: 100, quality: 'raw' as const, status: 'offline' as const, provenance: 'live' as const },
    { value: 0, quality: 'reported' as const, status: 'online' as const },
  ]) {
    assert.equal(inverterFlowState({ ...source, mode: 'live' }).streaming, false);
  }
});