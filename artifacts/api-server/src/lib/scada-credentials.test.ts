import assert from "node:assert/strict";
import test from "node:test";
import { hashScadaPassword, normalizeScadaUsername, verifyScadaPassword } from "./auth.ts";

test("normalizes safe SCADA usernames and rejects unsafe identifiers", () => {
  assert.equal(normalizeScadaUsername("  Plant.Operator  "), "plant.operator");
  assert.equal(normalizeScadaUsername("operator_01"), "operator_01");
  assert.equal(normalizeScadaUsername("ab"), null);
  assert.equal(normalizeScadaUsername("operator@example.com"), null);
});

test("hashes and verifies SCADA passwords without accepting a wrong password", async () => {
  const hash = await hashScadaPassword("correct-horse-battery-staple");
  assert.notEqual(hash, "correct-horse-battery-staple");
  assert.equal(await verifyScadaPassword("correct-horse-battery-staple", hash), true);
  assert.equal(await verifyScadaPassword("not-the-password", hash), false);
});