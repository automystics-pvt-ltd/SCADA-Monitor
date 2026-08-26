import assert from "node:assert/strict";
import test from "node:test";
import { PlatformTelemetryDestination, type PlatformTelemetryMappingPrecedent } from "@workspace/api-client-react";
import { suggestTelemetryMapping, type SuggestableParameter } from "./telemetry-mapping-suggestions.ts";

function precedent(overrides: Partial<PlatformTelemetryMappingPrecedent>): PlatformTelemetryMappingPrecedent {
  return {
    siteName: "Sambavi",
    deviceId: "ana",
    sourceName: "actpow",
    normalizedName: "actpow",
    address: "305031",
    destination: PlatformTelemetryDestination["active-power"],
    displayLabel: "Active Power",
    category: "Discovered / Other Parameters",
    inverterIdentity: "inv1",
    sourceUnit: "kW",
    displayUnit: "kW",
    scalingMultiplier: 1,
    scalingOffset: 0,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function parameter(overrides: Partial<SuggestableParameter>): SuggestableParameter {
  return {
    siteName: "Sambavi",
    deviceId: "ana",
    normalizedName: "actpow",
    address: "305031",
    sourceName: "actpow",
    sourceUnit: null,
    originalName: "ActPow",
    ...overrides,
  };
}

test("reuses an exact-address precedent's destination, label, category, units and transform", () => {
  const suggestion = suggestTelemetryMapping(
    parameter({ deviceId: "gateway-2", sourceName: "ActPow", address: "305031" }),
    [precedent({ scalingMultiplier: 0.1, scalingOffset: 2 })],
  );
  assert.ok(suggestion);
  assert.equal(suggestion.confidence, "precedent");
  assert.equal(suggestion.destination, PlatformTelemetryDestination["active-power"]);
  assert.equal(suggestion.displayLabel, "Active Power");
  assert.equal(suggestion.category, "Discovered / Other Parameters");
  assert.equal(suggestion.scalingMultiplier, 0.1);
  assert.equal(suggestion.scalingOffset, 2);
  assert.equal(suggestion.inverterIdentity, "inv1");
});

test("prefers the freshly observed source unit over a borrowed precedent unit", () => {
  const suggestion = suggestTelemetryMapping(
    parameter({ deviceId: "gateway-2", sourceUnit: "W" }),
    [precedent({ displayUnit: "kW" })],
  );
  assert.ok(suggestion);
  assert.equal(suggestion.displayUnit, "W");
});

test("falls back to the precedent's unit when this device reported none", () => {
  const suggestion = suggestTelemetryMapping(
    parameter({ deviceId: "gateway-2", sourceUnit: null }),
    [precedent({ displayUnit: "kW" })],
  );
  assert.ok(suggestion);
  assert.equal(suggestion.displayUnit, "kW");
});

test("never guesses inverter-identity destination heuristically, only from precedent or device inference", () => {
  const suggestion = suggestTelemetryMapping(parameter({ normalizedName: "inv3", sourceName: "inv3", address: null }), []);
  assert.equal(suggestion, null);
});

test("returns null when no precedent and no heuristic pattern matches, keeping today's discovered-other default", () => {
  const suggestion = suggestTelemetryMapping(parameter({ normalizedName: "xyzqty", sourceName: "xyzqty", address: "999999" }), []);
  assert.equal(suggestion, null);
});

const heuristicCases: Array<[string, PlatformTelemetryDestination]> = [
  ["mppt1voltage", PlatformTelemetryDestination.voltage],
  ["mppt1current", PlatformTelemetryDestination.current],
  ["dailyenergy", PlatformTelemetryDestination["daily-energy"]],
  ["totalenergy", PlatformTelemetryDestination["total-energy"]],
  ["todayyield", PlatformTelemetryDestination["specific-yield"]],
  ["gridfreq", PlatformTelemetryDestination.frequency],
  ["alarmstatus", PlatformTelemetryDestination.alarm],
  ["faultcode", PlatformTelemetryDestination.fault],
  ["commstatus", PlatformTelemetryDestination.communication],
  ["moduletemp", PlatformTelemetryDestination.environmental],
];

for (const [normalizedName, expectedDestination] of heuristicCases) {
  test(`heuristically maps "${normalizedName}" to ${expectedDestination} with no precedent`, () => {
    const suggestion = suggestTelemetryMapping(
      parameter({ normalizedName, sourceName: normalizedName, address: null, sourceUnit: null }),
      [],
    );
    assert.ok(suggestion, `expected a suggestion for ${normalizedName}`);
    assert.equal(suggestion.destination, expectedDestination);
    assert.equal(suggestion.confidence, "heuristic");
    assert.equal(suggestion.scalingMultiplier, 1, "heuristic suggestions never fabricate a scaling multiplier");
    assert.equal(suggestion.scalingOffset, 0, "heuristic suggestions never fabricate a scaling offset");
  });
}

test("heuristically shoehorns an unrecognized 'power' reading onto active-power, matching admin convention", () => {
  const suggestion = suggestTelemetryMapping(
    parameter({ normalizedName: "aphpower", sourceName: "aphpower", address: "305085", sourceUnit: null }),
    [],
  );
  assert.ok(suggestion);
  assert.equal(suggestion.destination, PlatformTelemetryDestination["active-power"]);
  assert.equal(suggestion.confidence, "heuristic");
});

test("infers a device's established inverter identity for a new active-power signal on the same device", () => {
  const precedents = [
    precedent({ sourceName: "actpow", normalizedName: "actpow", inverterIdentity: "inv1" }),
    precedent({ sourceName: "pf", normalizedName: "pf", address: "305033", inverterIdentity: "inv1" }),
  ];
  const suggestion = suggestTelemetryMapping(
    parameter({ normalizedName: "aphpower", sourceName: "aphpower", address: "305085", sourceUnit: null }),
    precedents,
  );
  assert.ok(suggestion);
  assert.equal(suggestion.inverterIdentity, "inv1");
});

test("leaves inverter identity unset for a plant-level meter reading, even on a device with an established inverter", () => {
  const precedents = [precedent({ sourceName: "actpow", normalizedName: "actpow", inverterIdentity: "inv1" })];
  const suggestion = suggestTelemetryMapping(
    parameter({ normalizedName: "meterpower", sourceName: "meterpower", address: "305083", sourceUnit: null }),
    precedents,
  );
  assert.ok(suggestion);
  assert.equal(suggestion.destination, PlatformTelemetryDestination["active-power"]);
  assert.equal(suggestion.inverterIdentity, null, "a plant-level meter must not inherit a single inverter's identity");
});

test("leaves inverter identity unset when the device's other mappings disagree on which inverter", () => {
  const precedents = [
    precedent({ deviceId: "multi", sourceName: "actpow", normalizedName: "actpow", inverterIdentity: "inv1" }),
    precedent({ deviceId: "multi", sourceName: "actpow2", normalizedName: "actpow2", address: "305090", inverterIdentity: "inv2" }),
  ];
  const suggestion = suggestTelemetryMapping(
    parameter({ deviceId: "multi", normalizedName: "bphpower", sourceName: "bphpower", address: "305087", sourceUnit: null }),
    precedents,
  );
  assert.ok(suggestion);
  assert.equal(suggestion.inverterIdentity, null);
});

test("regression: a suggestion is a plain, inert value — it carries no path that activates a mapping", () => {
  const precedents = [precedent({})];
  const before = JSON.stringify(precedents);
  const suggestion = suggestTelemetryMapping(parameter({ deviceId: "gateway-2" }), precedents);
  assert.ok(suggestion);
  // Computing a suggestion must never mutate the precedent list it read from.
  assert.equal(JSON.stringify(precedents), before);
  // The suggestion is data only: no destination/site write ever happens
  // unless the admin's own save action later submits a PlatformTelemetryMappingInput.
  assert.equal(typeof suggestion, "object");
  assert.ok(!("save" in suggestion) && !("activate" in suggestion) && !("status" in suggestion));
});
