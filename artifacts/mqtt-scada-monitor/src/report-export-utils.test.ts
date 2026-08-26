import assert from 'node:assert/strict';
import test from 'node:test';
import { csvValue, sanitizeSpreadsheetText } from './report-export-utils.ts';

// Saved telemetry text (parameter names, source identities, raw/source-reported values, reasons)
// is externally supplied MQTT evidence, not operator input. A malicious or garbled source string
// that opens with =, +, -, @, tab, or CR can be evaluated as a formula when an operator opens a
// CSV/XLSX export in Excel or Sheets. Every export path must neutralize these before serializing.
const MALICIOUS_STRINGS = [
  '=1+1',
  '=cmd|"/c calc"!A1',
  '+SUM(A1:A9)',
  '-2+3',
  '@SUM(1,2)',
  '\t=1+1',
  '\r=1+1',
];

test('sanitizeSpreadsheetText neutralizes every formula-leading telemetry string', () => {
  for (const malicious of MALICIOUS_STRINGS) {
    const sanitized = sanitizeSpreadsheetText(malicious);
    assert.ok(sanitized.startsWith("'"), `expected a leading quote for ${JSON.stringify(malicious)}, got ${JSON.stringify(sanitized)}`);
    assert.equal(sanitized.slice(1), malicious);
  }
});

test('sanitizeSpreadsheetText leaves ordinary telemetry text untouched', () => {
  assert.equal(sanitizeSpreadsheetText('AC voltage'), 'AC voltage');
  assert.equal(sanitizeSpreadsheetText('Inverter 2'), 'Inverter 2');
  assert.equal(sanitizeSpreadsheetText(null), '');
  assert.equal(sanitizeSpreadsheetText(42), '42');
});

test('csvValue emits malicious source strings as literal text, not formulas', () => {
  for (const malicious of MALICIOUS_STRINGS) {
    const value = csvValue(malicious);
    // Whether or not the value is CSV-quoted, the first content character after any opening
    // quote must be the defusing single quote, never the original formula-leading character.
    const contentStart = value.startsWith('"') ? value.slice(1) : value;
    assert.ok(contentStart.startsWith("'"), `expected csvValue(${JSON.stringify(malicious)}) to defuse the formula, got ${JSON.stringify(value)}`);
  }
});

test('csvValue still quotes normal CSV-special characters correctly', () => {
  assert.equal(csvValue('plain'), 'plain');
  assert.equal(csvValue('has,comma'), '"has,comma"');
  assert.equal(csvValue('has "quote"'), '"has ""quote"""');
  assert.equal(csvValue('multi\nline'), '"multi\nline"');
});
