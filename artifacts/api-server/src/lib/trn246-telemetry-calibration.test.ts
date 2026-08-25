import assert from "node:assert/strict";
import test from "node:test";
import { applyTrn246TelemetryCalibration } from "./trn246-telemetry-calibration.ts";

test("preserves an explicitly reported active-power value without inferring scaling or validation", () => {
  const annotated = applyTrn246TelemetryCalibration({
    name: "actpow",
    data: -11_309.54752,
    raw_data: "raw-register-evidence",
    full_addr: "305031",
    server_name: "ana",
  });

  assert.equal(annotated.data, -11_309.54752);
  assert.equal(annotated.reported_value, -11_309.54752);
  assert.equal(annotated.reported_unit, "kW");
  assert.equal(annotated.source_raw_value, "raw-register-evidence");
  assert.equal(annotated.source_mapping_status, "source-reported");
  assert.equal(annotated.scaling_validated, undefined);
  assert.equal(annotated.semantic, undefined);
});

test("maps the PDF totalenergy row as a source-reported cumulative MWh counter only", () => {
  const annotated = applyTrn246TelemetryCalibration({
    name: "totalenergy",
    data: 30_670.848,
    raw_data: "30670848",
    full_addr: "305008",
    server_name: "ana",
  });

  assert.equal(annotated.data, 30_670.848);
  assert.equal(annotated.reported_value, 30_670.848);
  assert.equal(annotated.reported_unit, "MWh");
  assert.equal(annotated.source_counter_role, "cumulative-counter");
  assert.equal(annotated.scaling_validated, undefined);
  assert.equal(annotated.semantic, undefined);
});

test("keeps the five PDF inverter identity rows distinct despite their shared source and register", () => {
  const rows = [1, 2, 3, 4, 5].map((number) => applyTrn246TelemetryCalibration({
    name: `inv${number}`,
    data: 2134,
    raw_data: "2134",
    full_addr: "305003",
    server_name: "ana",
  }));

  assert.deepEqual(rows.map((row) => row.inverter_id), ["inv1", "inv2", "inv3", "inv4", "inv5"]);
  assert.equal(new Set(rows.map((row) => row.source_identity)).size, 5);
  assert.ok(rows.every((row) => row.measurement_type === "inverter_identity"));
  assert.ok(rows.every((row) => row.reported_value === 2134 && row.reported_unit === undefined));
  assert.ok(rows.every((row) => row.scaling_validated === undefined));
});

test("does not call a data-only payload customer-facing evidence", () => {
  const annotated = applyTrn246TelemetryCalibration({
    name: "todayyield",
    data: 22.024,
    full_addr: "305003",
    server_name: "ana",
  });

  assert.equal(annotated.source_mapping_status, "raw");
  assert.equal(annotated.reported_unit, undefined);
  assert.equal(annotated.data, 22.024);
});