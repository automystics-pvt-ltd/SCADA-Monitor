import assert from "node:assert/strict";
import test from "node:test";
import {
  keepReportRecord,
  reportCategoryForParameter,
  sourceExplicitlyValidatesEngineeringValue,
  stableReportRecordId,
  type ReportFilterSet,
  type ScadaReportRecord,
} from "./scada-reporting.ts";

const record: ScadaReportRecord = {
  id: "m-1",
  recordType: "measurement",
  category: "electrical",
  siteName: "Plant A",
  deviceId: "inv-01",
  deviceName: "Inverter 01",
  parameter: "AC voltage",
  displayLabel: "AC voltage",
  value: 415,
  unit: "V",
  address: "301001",
  sourceName: "Inverter archive",
  observedAt: "2026-08-24T09:00:00.000Z",
  receivedAt: "2026-08-24T09:00:01.000Z",
  provenance: "historical-saved",
  quality: "validated",
  status: null,
  reason: null,
};

test("classifies report parameters without inventing engineering values", () => {
  assert.equal(reportCategoryForParameter("Phase A voltage"), "electrical");
  assert.equal(reportCategoryForParameter("daily_energy_kwh"), "energy");
  assert.equal(reportCategoryForParameter("Fault code"), "alarms");
  assert.equal(reportCategoryForParameter("wind_speed"), "environmental");
  assert.equal(sourceExplicitlyValidatesEngineeringValue({ scaling_status: "validated" }), true);
  assert.equal(sourceExplicitlyValidatesEngineeringValue({ unit: "V" }), false);
});

test("keeps provenance and validated-only filters separate", () => {
  const filters: ReportFilterSet = { devices: ["inv-01"], parameters: ["AC voltage"], provenance: ["historical-saved"], quality: "validated", status: "all" };
  assert.equal(keepReportRecord(record, "electrical", filters), true);
  assert.equal(keepReportRecord({ ...record, provenance: "live" }, "electrical", filters), false);
  assert.equal(keepReportRecord({ ...record, quality: "raw" }, "electrical", { ...filters, quality: "all" }), true);
  assert.equal(keepReportRecord({ ...record, quality: "raw" }, "electrical", filters), false);
});

test("scopes named operational report views to semantically appropriate evidence", () => {
  const noFilters: ReportFilterSet = { devices: [], parameters: [], provenance: [], quality: "all", status: "all" };
  const acPower = { ...record, parameter: "AC active power", displayLabel: "AC active power", measurementKind: "active-power" };
  const mppt = { ...record, parameter: "MPPT 1 voltage", displayLabel: "MPPT 1 voltage" };
  const string = { ...record, parameter: "String 1 current", displayLabel: "String 1 current" };
  const temperature = { ...record, category: "environmental" as const, parameter: "Cabinet temperature", displayLabel: "Cabinet temperature" };
  const frequency = { ...record, parameter: "Grid frequency", displayLabel: "Grid frequency" };

  assert.equal(keepReportRecord(acPower, "ac-dc-power", noFilters), true);
  assert.equal(keepReportRecord(acPower, "electrical-parameters", noFilters), false);
  assert.equal(keepReportRecord(mppt, "mppt-monitoring", noFilters), true);
  assert.equal(keepReportRecord(string, "string-monitoring", noFilters), true);
  assert.equal(keepReportRecord(temperature, "temperature-monitoring", noFilters), true);
  assert.equal(keepReportRecord(frequency, "power-factor-frequency", noFilters), true);
  assert.equal(keepReportRecord({ ...record, provenance: "live" }, "live-data", noFilters), true);
  assert.equal(keepReportRecord(record, "live-data", noFilters), false);
  assert.equal(keepReportRecord(record, "historical-saved", noFilters), true);
});

test("uses receipt identity and value when source timestamps repeat", () => {
  const first = stableReportRecordId({ source: "archive", parameter: "AC power", address: "305040", observedAt: "2026-08-24T09:00:00.000Z", receivedAt: "2026-08-24T09:00:01.000Z", value: 12.4 });
  const second = stableReportRecordId({ source: "archive", parameter: "AC power", address: "305040", observedAt: "2026-08-24T09:00:00.000Z", receivedAt: "2026-08-24T09:00:02.000Z", value: 12.6 });
  assert.notEqual(first, second);
});

test("keeps same-register samples from different devices distinct", () => {
  const base = { source: "archive", siteName: "Plant A", parameter: "AC power", address: "305040", observedAt: "2026-08-24T09:00:00.000Z", receivedAt: "2026-08-24T09:00:01.000Z", value: 12.4 };
  assert.notEqual(
    stableReportRecordId({ ...base, deviceId: "inv-01" }),
    stableReportRecordId({ ...base, deviceId: "inv-02" }),
  );
});