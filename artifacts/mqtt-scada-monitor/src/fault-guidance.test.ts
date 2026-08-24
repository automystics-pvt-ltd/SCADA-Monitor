import assert from "node:assert/strict";
import test from "node:test";
import { collectAlarmFaultEvidence, collectAlarmFaultEvidenceFromRows, getFaultGuidance, normalizeFaults } from "./fault-guidance.ts";

test("normalizes a source-reported inverter fault with its evidence", () => {
  const [fault] = normalizeFaults([{
    faultCode: 4,
    source: "System information",
    timestamp: "2026-08-24T10:00:00.000Z",
    description: "Grid voltage is lower than the configured protection value.",
  }]);

  assert.ok(fault);
  assert.equal(fault.code, "4");
  assert.equal(fault.source, "System information");
  assert.equal(fault.reportedReason, "Grid voltage is lower than the configured protection value.");
  assert.equal(getFaultGuidance(fault).mapping, "source-reported");
});

test("uses the scoped reference guidance for fault code 4 without a source reason", () => {
  const [fault] = normalizeFaults([4]);
  assert.ok(fault);

  const guidance = getFaultGuidance(fault, "SG250HX-IN");
  assert.equal(guidance.mapping, "reference-mapped");
  assert.equal(guidance.title, "Grid undervoltage protection");
  assert.match(guidance.reason, /Grid voltage is lower/i);
  assert.ok(guidance.suggestions.length >= 3);
  assert.match(guidance.scope, /verify against manufacturer manual/i);
});

test("keeps unknown fault codes visible without inventing a reason", () => {
  const [fault] = normalizeFaults([{ code: "X-901", source: "Inverter" }]);
  assert.ok(fault);

  const guidance = getFaultGuidance(fault);
  assert.equal(guidance.mapping, "unmapped");
  assert.equal(guidance.reason, "Reason not mapped for this source code.");
  assert.match(guidance.suggestions.at(-1) ?? "", /authorized service team/i);
});

test("collects scalar alarm and fault fields without requiring arrays", () => {
  const evidence = collectAlarmFaultEvidence({
    alarmCode: "A-12",
    fault_code: 4,
  });

  assert.equal(evidence.alarms.length, 1);
  assert.equal(evidence.alarms[0]?.code, "A-12");
  assert.equal(evidence.faults.length, 1);
  assert.equal(evidence.faults[0]?.code, "4");
});

test("keeps source alarm and fault register evidence traceable", () => {
  const evidence = collectAlarmFaultEvidenceFromRows([
    { name: "Alarm Code", data: "A-12", raw_data: "A-12", server_name: "INV-01", timestamp: "2026-08-24T10:00:00Z" },
    { name: "Fault Code", data: 4, raw_data: 4, server_name: "INV-01", timestamp: "2026-08-24T10:00:01Z" },
  ]);

  assert.equal(evidence.alarms[0]?.source, "INV-01");
  assert.equal(evidence.alarms[0]?.code, "A-12");
  assert.equal(evidence.faults[0]?.code, "4");
  assert.equal(evidence.faults[0]?.rawValue, "4");
});