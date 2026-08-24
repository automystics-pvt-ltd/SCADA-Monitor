import assert from "node:assert/strict";
import test from "node:test";
import { canUpdatePlantLocation } from "./plantLocationAuthorization";

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

test("allows only configured sites for a configured operator", () => {
  const access = JSON.stringify({ "email:operator@example.com": ["East Array"] });
  assert.equal(canUpdatePlantLocation(operator, "East Array", access), true);
  assert.equal(canUpdatePlantLocation(operator, "West Array", access), false);
});

test("allows a deliberately global subject assignment", () => {
  const access = JSON.stringify({ "id:operator-subject": ["*"] });
  assert.equal(canUpdatePlantLocation(operator, "Any Site", access), true);
});