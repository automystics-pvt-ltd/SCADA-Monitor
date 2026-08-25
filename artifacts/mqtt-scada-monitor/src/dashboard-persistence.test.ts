import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORICAL_SAVING_RESUME_MESSAGE, persistenceNextSaveLabel, persistenceResumeMessage } from './dashboard-persistence.ts';

test('labels paused historical saving without relabeling live telemetry', () => {
  assert.equal(persistenceResumeMessage(false), HISTORICAL_SAVING_RESUME_MESSAGE);
  assert.equal(persistenceResumeMessage(true), undefined);
  assert.equal(persistenceResumeMessage(undefined), undefined);
});

test('keeps the next daytime save visible while historical saving is paused', () => {
  assert.equal(
    persistenceNextSaveLabel(false, '2026-08-26T00:30:00.000Z', Date.parse('2026-08-25T18:00:00.000Z'), 15, (milliseconds) => `${Math.round(milliseconds / 3_600_000)}h`),
    '7h',
  );
  assert.equal(
    persistenceNextSaveLabel(true, undefined, Date.now(), 15, () => 'unused'),
    '15m cycle',
  );
});