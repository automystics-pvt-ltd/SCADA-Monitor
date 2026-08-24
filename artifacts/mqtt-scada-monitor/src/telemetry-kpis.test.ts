import assert from "node:assert/strict";
import test from "node:test";
import { latestRawMetric, rawInverterSignals } from "./telemetry-kpis.ts";

test("selects the newest named raw register and keeps replay provenance", () => {
  const metric = latestRawMetric([
    { name: "actpow", data: "100", full_addr: "305031", timestamp: 100, provenance: "replay" },
    { name: "actpow", data: "200", full_addr: "305031", timestamp: 200, provenance: "live" },
  ], ["actpow"]);

  assert.deepEqual(metric, {
    parameter: "actpow",
    value: 200,
    address: "305031",
    provenance: "live",
  });
});

test("reports only numeric inverter register signals", () => {
  const signals = rawInverterSignals([
    { name: "inv2", data: "1041", addr: 2, provenance: "replay" },
    { name: "inv1", data: "1041", addr: 1, provenance: "live" },
    { name: "inv3", data: "unknown", addr: 3, provenance: "live" },
  ]);

  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.parameter), ["inv1", "inv2"]);
});