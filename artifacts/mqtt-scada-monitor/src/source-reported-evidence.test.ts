import assert from 'node:assert/strict';
import test from 'node:test';
import { isSourceReportedEvidence, sourceReportedTelemetryValue, transportRawTelemetryValue } from './source-reported-evidence.ts';

test('keeps a data-only Modbus payload raw until a source mapping is reviewed', () => {
  const payload = { name: 'unmapped_register', data: 65535, raw_data: '65535' };
  assert.equal(isSourceReportedEvidence(payload), false);
  assert.equal(sourceReportedTelemetryValue(payload), undefined);
  assert.equal(transportRawTelemetryValue(payload), '65535');
});

test('recognizes a reviewed TRN246 row as source-reported while retaining its transport raw value', () => {
  const payload = {
    name: 'totalenergy',
    data: 30_670.848,
    reported_value: 30_670.848,
    reported_unit: 'MWh',
    raw_data: '30670848',
    source_mapping_status: 'source-reported',
  };
  assert.equal(isSourceReportedEvidence(payload), true);
  assert.equal(sourceReportedTelemetryValue(payload), 30_670.848);
  assert.equal(transportRawTelemetryValue(payload), '30670848');
});

test('honors a reviewed raw mapping even if its annotation retained a convenience reported_value field', () => {
  const payload = {
    data: 22.024,
    reported_value: 22.024,
    source_mapping_status: 'raw',
  };
  assert.equal(isSourceReportedEvidence(payload), false);
  assert.equal(sourceReportedTelemetryValue(payload), undefined);
});