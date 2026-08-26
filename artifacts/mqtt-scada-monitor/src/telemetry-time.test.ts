import assert from "node:assert/strict";
import test from "node:test";
import { telemetryDateTime, telemetryEpoch } from "./telemetry-time.ts";

test("telemetryEpoch parses an ISO-8601 string", () => {
  const epoch = telemetryEpoch({ date_iso_8601: "2024-03-15T10:30:00.000Z" });
  assert.equal(epoch, new Date("2024-03-15T10:30:00.000Z").getTime());
});

test("telemetryEpoch parses a unix-seconds number", () => {
  const epoch = telemetryEpoch({ timestamp: 1_710_498_600 });
  assert.equal(epoch, 1_710_498_600 * 1000);
});

test("telemetryEpoch parses a unix-milliseconds number", () => {
  const epoch = telemetryEpoch({ timestamp: 1_710_498_600_000 });
  assert.equal(epoch, 1_710_498_600_000);
});

test("telemetryEpoch prefers date_iso_8601 over timestamp and date", () => {
  const epoch = telemetryEpoch({
    date_iso_8601: "2024-03-15T10:30:00.000Z",
    timestamp: 0,
    date: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(epoch, new Date("2024-03-15T10:30:00.000Z").getTime());
});

test("telemetryEpoch falls back to timestamp, then date, when earlier fields are absent", () => {
  const withTimestamp = telemetryEpoch({ timestamp: 1_710_498_600 });
  assert.equal(withTimestamp, 1_710_498_600 * 1000);

  const withDate = telemetryEpoch({ date: "2024-03-15T10:30:00.000Z" });
  assert.equal(withDate, new Date("2024-03-15T10:30:00.000Z").getTime());
});

test("telemetryEpoch returns null when no timestamp field is present", () => {
  assert.equal(telemetryEpoch({}), null);
});

test("telemetryEpoch returns null for null, undefined, and empty-string values", () => {
  assert.equal(telemetryEpoch({ date_iso_8601: null }), null);
  assert.equal(telemetryEpoch({ date_iso_8601: undefined as unknown as null }), null);
  assert.equal(telemetryEpoch({ date_iso_8601: "" }), null);
});

test("telemetryEpoch returns null for an unparsable timestamp string", () => {
  assert.equal(telemetryEpoch({ date_iso_8601: "not-a-real-date" }), null);
});

test("telemetryDateTime formats an ISO-8601 string into date, time, and full parts", () => {
  const parsed = telemetryDateTime({ date_iso_8601: "2024-03-15T10:30:00.000Z" });
  const expected = new Date("2024-03-15T10:30:00.000Z");
  assert.equal(parsed.date, expected.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }));
  assert.equal(parsed.time, expected.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
  assert.equal(parsed.full, expected.toLocaleString());
});

test("telemetryDateTime formats a unix-seconds number", () => {
  const parsed = telemetryDateTime({ timestamp: 1_710_498_600 });
  const expected = new Date(1_710_498_600 * 1000);
  assert.equal(parsed.date, expected.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }));
  assert.equal(parsed.full, expected.toLocaleString());
});

test("telemetryDateTime formats a unix-milliseconds number", () => {
  const parsed = telemetryDateTime({ timestamp: 1_710_498_600_000 });
  const expected = new Date(1_710_498_600_000);
  assert.equal(parsed.date, expected.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" }));
  assert.equal(parsed.full, expected.toLocaleString());
});

test("telemetryDateTime returns the unavailable placeholder when no timestamp field is present", () => {
  assert.deepEqual(telemetryDateTime({}), { date: "—", time: "—", full: "Timestamp unavailable" });
});

test("telemetryDateTime returns the unavailable placeholder for null, undefined, and empty-string values", () => {
  const unavailable = { date: "—", time: "—", full: "Timestamp unavailable" };
  assert.deepEqual(telemetryDateTime({ date_iso_8601: null }), unavailable);
  assert.deepEqual(telemetryDateTime({ date_iso_8601: undefined as unknown as null }), unavailable);
  assert.deepEqual(telemetryDateTime({ date_iso_8601: "" }), unavailable);
});

test("telemetryDateTime echoes the raw source value when it cannot be parsed as a date", () => {
  const parsed = telemetryDateTime({ date_iso_8601: "not-a-real-date" });
  assert.deepEqual(parsed, { date: "not-a-real-date", time: "—", full: "not-a-real-date" });
});
