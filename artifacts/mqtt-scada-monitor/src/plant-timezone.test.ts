import assert from "node:assert/strict";
import test from "node:test";
import { formatInPlantTimezone } from "./plant-timezone.ts";

test("formats an ISO timestamp in a valid plant timezone", () => {
  const formatted = formatInPlantTimezone("2024-03-15T10:30:00.000Z", "Asia/Kolkata");
  assert.equal(formatted, "15 Mar, 16:00");
});

test("falls back to UTC when the timezone is undefined", () => {
  const formatted = formatInPlantTimezone("2024-03-15T10:30:00.000Z", undefined);
  assert.equal(formatted, "15 Mar, 10:30");
});

test("falls back to UTC when the timezone is an empty string", () => {
  const formatted = formatInPlantTimezone("2024-03-15T10:30:00.000Z", "");
  assert.equal(formatted, "15 Mar, 10:30");
});

test("returns the unavailable placeholder when the value is undefined", () => {
  assert.equal(formatInPlantTimezone(undefined, "Asia/Kolkata"), "—");
});

test("returns the unavailable placeholder when the value is an empty string", () => {
  assert.equal(formatInPlantTimezone("", "Asia/Kolkata"), "—");
});

test("returns the unavailable placeholder for a malformed date value", () => {
  assert.equal(formatInPlantTimezone("not-a-real-date", "Asia/Kolkata"), "—");
});

test("falls back to an ISO string when the configured timezone identifier is invalid", () => {
  const value = "2024-03-15T10:30:00.000Z";
  const formatted = formatInPlantTimezone(value, "Not/AZone");
  assert.equal(formatted, new Date(value).toISOString());
});
