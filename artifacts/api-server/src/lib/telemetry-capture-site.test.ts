import assert from "node:assert/strict";
import test from "node:test";
import { managedSourceIdentity, telemetryCaptureSite } from "./telemetry-capture-site.ts";

test("assigns an unscoped MQTT source only when one managed site is available", () => {
  assert.equal(telemetryCaptureSite(undefined, "Sambavi", "trn246/modbus"), "Sambavi");
  assert.equal(telemetryCaptureSite(undefined, undefined, "trn246/modbus"), "trn246/modbus");
});

test("never relabels an explicitly declared source site", () => {
  assert.equal(telemetryCaptureSite("Remote Plant", "Sambavi", "trn246/modbus"), "Remote Plant");
});

test("uses the managed-site source identity for legacy configured-source evidence", () => {
  assert.equal(
    managedSourceIdentity("Sambavi", "ana", "alarm", "305007"),
    "Sambavi|ana|alarm|305007",
  );
});