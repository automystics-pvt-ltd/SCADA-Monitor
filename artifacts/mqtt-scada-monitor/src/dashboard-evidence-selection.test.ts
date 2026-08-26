import assert from 'node:assert/strict';
import test from 'node:test';

import { selectDashboardEvidenceSource } from './dashboard-evidence-selection.ts';

test('uses fresh direct telemetry instead of a saved snapshot', () => {
  assert.equal(selectDashboardEvidenceSource({
    mode: 'live',
    liveState: 'fresh',
    hasSavedEvidence: true,
  }), 'live');
});

test('uses confirmed saved evidence only while live telemetry is stale or unavailable', () => {
  assert.equal(selectDashboardEvidenceSource({
    mode: 'live',
    liveState: 'stale',
    hasSavedEvidence: true,
  }), 'saved');
  assert.equal(selectDashboardEvidenceSource({
    mode: 'live',
    liveState: 'unavailable',
    hasSavedEvidence: true,
  }), 'saved');
  assert.equal(selectDashboardEvidenceSource({
    mode: 'live',
    liveState: 'unavailable',
    hasSavedEvidence: false,
  }), 'none');
});