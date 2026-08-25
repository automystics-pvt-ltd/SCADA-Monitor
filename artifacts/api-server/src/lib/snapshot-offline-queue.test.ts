import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotOfflineQueue } from "./snapshot-offline-queue.ts";

test("offline snapshot queue deduplicates retries and restores chronological order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scada-snapshot-queue-"));
  const queue = new SnapshotOfflineQueue<{ value: string }>(join(directory, "pending.json"));

  try {
    await queue.upsert({
      id: "later",
      scheduledFor: "2026-08-25T10:15:00.000Z",
      queuedAt: "2026-08-25T10:15:01.000Z",
      payload: { value: "later" },
    });
    await queue.upsert({
      id: "earlier",
      scheduledFor: "2026-08-25T10:00:00.000Z",
      queuedAt: "2026-08-25T10:00:01.000Z",
      payload: { value: "earlier" },
    });
    await queue.upsert({
      id: "later",
      scheduledFor: "2026-08-25T10:15:00.000Z",
      queuedAt: "2026-08-25T10:15:02.000Z",
      payload: { value: "replacement" },
    });

    const reloaded = new SnapshotOfflineQueue<{ value: string }>(join(directory, "pending.json"));
    const entries = await reloaded.list();
    assert.deepEqual(entries.map((entry) => [entry.id, entry.payload.value]), [
      ["earlier", "earlier"],
      ["later", "replacement"],
    ]);

    const raw = await readFile(join(directory, "pending.json"), "utf8");
    assert.match(raw, /"version":1/);
    await reloaded.remove("earlier");
    assert.deepEqual((await reloaded.list()).map((entry) => entry.id), ["later"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});