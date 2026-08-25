import assert from "node:assert/strict";
import test from "node:test";
import {
  clearConfirmedSnapshotCache,
  readConfirmedSnapshotCache,
  writeConfirmedSnapshotCache,
} from "./confirmed-snapshot-cache.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const savedSnapshot = {
  id: 42,
  topic: "plant/site",
  windowStartedAt: "2026-08-25T10:00:00.000Z",
  windowEndedAt: "2026-08-25T10:15:00.000Z",
  scheduledFor: "2026-08-25T10:15:00.000Z",
  capturedAt: "2026-08-25T10:15:03.000Z",
  saveStatus: "saved" as const,
  messageCount: 4,
  parameterCount: 1,
  parameters: [],
  metrics: { activePower: null, dailyEnergy: null, totalEnergy: null, specificYield: null },
};

test("confirmed snapshot cache only returns backend-saved evidence and is site-scoped", () => {
  const storage = new MemoryStorage();
  writeConfirmedSnapshotCache(storage, "Plant A", savedSnapshot);
  assert.equal(readConfirmedSnapshotCache(storage, "Plant A")?.id, 42);
  assert.equal(readConfirmedSnapshotCache(storage, "Plant B"), null);

  writeConfirmedSnapshotCache(storage, "Plant B", { ...savedSnapshot, saveStatus: "incomplete" });
  assert.equal(readConfirmedSnapshotCache(storage, "Plant B"), null);

  clearConfirmedSnapshotCache(storage, "Plant A");
  assert.equal(readConfirmedSnapshotCache(storage, "Plant A"), null);
});