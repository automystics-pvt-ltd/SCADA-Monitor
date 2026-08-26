import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, mqttSnapshotsTable } from "@workspace/db";
import {
  dailyWindowBoundaries,
  persistenceSchedule,
  snapshotGapsInRange,
} from "./mqtt.ts";

test("dailyWindowBoundaries enumerates every 15-minute save boundary from 06:00 through 18:00 local time", () => {
  const local = persistenceSchedule(new Date("2026-08-01T10:00:00.000Z")).local;
  const boundaries = dailyWindowBoundaries(local);
  // 06:00..18:00 inclusive, every 15 minutes: (18-6)*4 + 1
  assert.equal(boundaries.length, 49);
  const first = boundaries[0]!;
  const last = boundaries.at(-1)!;
  assert.equal(first.getTime() < last.getTime(), true);
  for (let index = 1; index < boundaries.length; index += 1) {
    assert.equal(boundaries[index]!.getTime() - boundaries[index - 1]!.getTime(), 15 * 60_000, "every boundary must be exactly 15 minutes apart");
  }
});

const fixtureId = randomUUID();
const topic = `gap-detection-${fixtureId}`;
let insertedIds: number[] = [];

// Compute the plant's actual scheduled boundaries for one full local day
// rather than hardcoding UTC offsets, so this test holds regardless of the
// configured plant timezone.
const referenceDayLocal = persistenceSchedule(new Date("2026-08-10T10:00:00.000Z")).local;
const dayBoundaries = dailyWindowBoundaries(referenceDayLocal);
const savedWindowEnd = dayBoundaries[0]!;
const missingWindowEnd = dayBoundaries[1]!;
const incompleteWindowEnd = dayBoundaries[2]!;
const absentWindowEnd = dayBoundaries[3]!;
const dayRangeFrom = new Date(savedWindowEnd.getTime() - 60_000);
const dayRangeTo = dayBoundaries.at(-1)!;
const afterDayClose = new Date(dayRangeTo.getTime() + 30 * 60_000);

after(async () => {
  if (insertedIds.length) await db.delete(mqttSnapshotsTable).where(eq(mqttSnapshotsTable.topic, topic));
});

test("snapshotGapsInRange reports absent windows, preserves recorded missing/incomplete reasons, and never flags a genuinely saved window", async () => {
  const rows = await db.insert(mqttSnapshotsTable).values([
    {
      topic,
      windowStartedAt: new Date(savedWindowEnd.getTime() - 15 * 60_000),
      windowEndedAt: savedWindowEnd,
      capturedAt: savedWindowEnd,
      messageCount: 4,
      parameterCount: 6,
      data: { schemaVersion: 4, scheduledFor: savedWindowEnd.toISOString(), timezone: "plant" },
    },
    {
      topic,
      windowStartedAt: new Date(missingWindowEnd.getTime() - 15 * 60_000),
      windowEndedAt: missingWindowEnd,
      capturedAt: missingWindowEnd,
      messageCount: 0,
      parameterCount: 0,
      data: {
        schemaVersion: 4,
        saveStatus: "missing",
        missingReason: "The collection service may have been offline or restarted before it could save.",
        scheduledFor: missingWindowEnd.toISOString(),
        timezone: "plant",
      },
    },
    {
      topic,
      windowStartedAt: new Date(incompleteWindowEnd.getTime() - 15 * 60_000),
      windowEndedAt: incompleteWindowEnd,
      capturedAt: incompleteWindowEnd,
      messageCount: 2,
      parameterCount: 0,
      data: { schemaVersion: 4, scheduledFor: incompleteWindowEnd.toISOString(), timezone: "plant" },
    },
  ]).returning({ id: mqttSnapshotsTable.id });
  insertedIds = rows.map((row) => row.id);

  const { gaps, gapCount, expectedWindows } = await snapshotGapsInRange(afterDayClose, dayRangeFrom, dayRangeTo, topic);

  assert.equal(expectedWindows, 49, "a single fully-scheduled day always expects 49 windows");

  const saved = gaps.find((gap) => gap.scheduledFor === savedWindowEnd.toISOString());
  assert.equal(saved, undefined, "a genuinely saved window must never be reported as a gap");

  const absent = gaps.find((gap) => gap.scheduledFor === absentWindowEnd.toISOString());
  assert.ok(absent, "a window with no database row at all must be reported");
  assert.equal(absent!.saveStatus, "absent");

  const missing = gaps.find((gap) => gap.scheduledFor === missingWindowEnd.toISOString());
  assert.ok(missing, "an explicitly recorded missing window must be reported");
  assert.equal(missing!.saveStatus, "missing");
  assert.equal(missing!.missingReason, "The collection service may have been offline or restarted before it could save.");

  const incomplete = gaps.find((gap) => gap.scheduledFor === incompleteWindowEnd.toISOString());
  assert.ok(incomplete, "a saved-but-empty window must be reported as incomplete, not silently dropped");
  assert.equal(incomplete!.saveStatus, "incomplete");

  assert.equal(gapCount, gaps.length);
  assert.equal(gapCount, 48, "49 expected windows minus the single genuinely saved window");
});

test("snapshotGapsInRange never reports a window that has not been reached yet", async () => {
  // "now" lands exactly on the second boundary: only the first two windows
  // (index 0 and 1) have closed, everything after must be excluded entirely.
  const now = dayBoundaries[1]!;
  const { gaps, expectedWindows } = await snapshotGapsInRange(now, dayRangeFrom, dayRangeTo, topic);
  assert.equal(expectedWindows, 2);
  assert.equal(gaps.length, 1, "the saved window at index 0 must be excluded, leaving only the still-gapped window at index 1");
  assert.equal(gaps[0]!.scheduledFor, missingWindowEnd.toISOString());
});
