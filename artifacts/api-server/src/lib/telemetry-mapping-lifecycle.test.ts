import assert from "node:assert/strict";
import test from "node:test";
import { db, type PlatformTelemetryMapping } from "@workspace/db";
import { sql } from "drizzle-orm";
import { telemetryMappingIsUnchanged } from "./telemetry-mapping-lifecycle";

const mapping = {
  sourceName: "Gateway A",
  destination: "active-power",
  displayLabel: "Inverter AC power",
  category: "Electrical",
  inverterIdentity: "inv1",
  sourceUnit: "kW",
  displayUnit: "kW",
  scalingMultiplier: 1,
  scalingOffset: 0,
  scalingStatus: "approved",
  status: "active",
} satisfies Pick<PlatformTelemetryMapping, "sourceName" | "destination" | "displayLabel" | "category" | "inverterIdentity" | "sourceUnit" | "displayUnit" | "scalingMultiplier" | "scalingOffset" | "scalingStatus" | "status">;

test("treats an identical active mapping revision as a true no-op", () => {
  assert.equal(telemetryMappingIsUnchanged(mapping, { ...mapping }), true);
  assert.equal(telemetryMappingIsUnchanged({ ...mapping, sourceUnit: null }, { ...mapping, sourceUnit: "  " }), true);
});

test("requires a new revision for every visible transform or destination change", () => {
  assert.equal(telemetryMappingIsUnchanged(mapping, { ...mapping, scalingMultiplier: 1000 }), false);
  assert.equal(telemetryMappingIsUnchanged(mapping, { ...mapping, destination: "daily-energy" }), false);
  assert.equal(telemetryMappingIsUnchanged(mapping, { ...mapping, displayUnit: "W" }), false);
});

test("serializes a first discovery with a competing map or clear for its exact identity", async () => {
  const key = `mapping-lifecycle-test-${Date.now()}-${Math.random()}`;
  let releaseFirst!: () => void;
  let firstLocked!: () => void;
  const firstLock = new Promise<void>((resolve) => { firstLocked = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondEntered = false;

  const first = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    firstLocked();
    await release;
  });
  await firstLock;
  const second = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    secondEntered = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});