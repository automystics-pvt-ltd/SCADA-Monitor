import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportQuery, reportRange } from './report-center-utils.ts';

const filters = {
  reportType: 'electrical',
  siteName: 'Plant A',
  devices: ['inv-01'],
  parameters: ['AC voltage'],
  status: 'all',
  quality: 'validated',
  provenance: ['historical-saved'],
  preset: 'custom',
  customFrom: '2026-08-01',
  customTo: '2026-08-03',
};

test('serializes the applied Report Center filters without dropping provenance', () => {
  const query = buildReportQuery(filters, new Date('2026-08-24T10:00:00Z'));
  assert.equal(query.get('reportType'), 'electrical');
  assert.equal(query.get('siteName'), 'Plant A');
  assert.equal(query.get('devices'), 'inv-01');
  assert.equal(query.get('parameters'), 'AC voltage');
  assert.equal(query.get('provenance'), 'historical-saved');
  assert.equal(query.get('quality'), 'validated');
});

test('uses the custom calendar bounds supplied by the operator', () => {
  const range = reportRange(filters, new Date('2026-08-24T10:00:00Z'));
  assert.equal(range.from, new Date('2026-08-01T00:00:00').toISOString());
  assert.equal(range.to, new Date('2026-08-03T23:59:59.999').toISOString());
});

test('uses optional custom time bounds without changing the selected dates', () => {
  const range = reportRange({ ...filters, customFromTime: '06:30', customToTime: '18:15' }, new Date('2026-08-24T10:00:00Z'));
  assert.equal(range.from, new Date('2026-08-01T06:30:00').toISOString());
  assert.equal(range.to, new Date('2026-08-03T18:15:59.999').toISOString());
});

test('adds a bounded screen page without changing the exact report period', () => {
  const query = buildReportQuery(filters, new Date('2026-08-24T10:00:00Z'), { page: 3, pageSize: 200 });
  assert.equal(query.get('page'), '3');
  assert.equal(query.get('pageSize'), '200');
  assert.equal(query.get('complete'), null);
  assert.equal(query.get('from'), new Date('2026-08-01T00:00:00').toISOString());
  assert.equal(query.get('to'), new Date('2026-08-03T23:59:59.999').toISOString());
});

test('marks complete report retrieval explicitly for exports', () => {
  const query = buildReportQuery(filters, undefined, { complete: true });
  assert.equal(query.get('complete'), 'true');
  assert.equal(query.get('page'), null);
});

test('reuses the exact resolved preview boundaries for a page or export request', () => {
  const query = buildReportQuery(filters, new Date('2026-08-24T10:00:00Z'), {
    page: 2,
    range: { from: '2026-08-01T06:30:00.000Z', to: '2026-08-03T18:15:59.999Z' },
  });
  assert.equal(query.get('from'), '2026-08-01T06:30:00.000Z');
  assert.equal(query.get('to'), '2026-08-03T18:15:59.999Z');
  assert.equal(query.get('page'), '2');
});