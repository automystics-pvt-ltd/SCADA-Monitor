import assert from "node:assert/strict";
import test from "node:test";
import { canUpdatePlantLocation, isPlantLocationAdministrator } from "./plantLocationAuthorization.ts";

const operator = {
  id: "operator-subject",
  email: "operator@example.com",
  firstName: "Operator",
  lastName: null,
  profileImageUrl: null,
};

test("rejects unauthenticated and unassigned identities", () => {
  assert.equal(canUpdatePlantLocation(undefined, "East Array", "{}"), false);
  assert.equal(canUpdatePlantLocation(operator, "East Array", "{}"), false);
});

test("allows a configured administrator to update every site", () => {
  const access = JSON.stringify(["email:operator@example.com"]);
  assert.equal(canUpdatePlantLocation(operator, "East Array", access), true);
  assert.equal(canUpdatePlantLocation(operator, "West Array", access), true);
});

test("matches administrator email identities case-insensitively", () => {
  const access = JSON.stringify(["email:OPERATOR@EXAMPLE.COM"]);
  assert.equal(isPlantLocationAdministrator(operator, access), true);
});

test("fails closed for the old site-assignment format", () => {
  const legacyAccess = JSON.stringify({ "id:operator-subject": ["*"] });
  assert.equal(canUpdatePlantLocation(operator, "Any Site", legacyAccess), false);
});
