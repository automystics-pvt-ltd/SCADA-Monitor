import assert from "node:assert/strict";
import test from "node:test";
import { appendLiveEnergySamples, liveEnergySamplesFromRows, selectLiveEnergySeries } from "./energy-stream.ts";

test("creates a live energy lane from daily source counters only", () => {
  const samples = liveEnergySamplesFromRows([
    { name: "daily_energy", data: "142.5", full_addr: "40101", server_name: "Plant meter", date_iso_8601: "2026-08-25T08:00:00.000Z" },
    { name: "actpow", data: 95, full_addr: "40001", server_name: "Plant meter" },
  ], "2026-08-25T08:00:02.000Z");

  assert.deepEqual(samples.map((sample) => [sample.parameter, sample.value, sample.address]), [["daily_energy", 142.5, "40101"]]);
  assert.equal(samples[0]?.sourceObservedAt, "2026-08-25T08:00:00.000Z");
});

test("keeps one source/register lane and removes duplicate source observations", () => {
  const first = liveEnergySamplesFromRows([
    { name: "today_energy", data: 10, full_addr: "40101", server_name: "Plant meter", timestamp: "2026-08-25T08:00:00.000Z" },
  ], "2026-08-25T08:00:01.000Z");
  const duplicate = liveEnergySamplesFromRows([
    { name: "today_energy", data: 10, full_addr: "40101", server_name: "Plant meter", timestamp: "2026-08-25T08:00:00.000Z" },
  ], "2026-08-25T08:00:01.000Z");
  const next = liveEnergySamplesFromRows([
    { name: "today_energy", data: 11, full_addr: "40101", server_name: "Plant meter", timestamp: "2026-08-25T08:01:00.000Z" },
  ], "2026-08-25T08:01:01.000Z");
  const otherMeter = liveEnergySamplesFromRows([
    { name: "today_energy", data: 200, full_addr: "50101", server_name: "Second meter", timestamp: "2026-08-25T08:01:30.000Z" },
  ], "2026-08-25T08:01:31.000Z");

  const buffered = appendLiveEnergySamples(appendLiveEnergySamples(first, duplicate), [...next, ...otherMeter]);
  const preferred = selectLiveEnergySeries(buffered, { parameter: "today_energy", address: "40101" });

  assert.equal(buffered.length, 3);
  assert.deepEqual(preferred.map((sample) => sample.value), [10, 11]);
  assert.equal(preferred.every((sample) => sample.address === "40101"), true);
});