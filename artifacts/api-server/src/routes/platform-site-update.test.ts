import assert from "node:assert/strict";
import test from "node:test";
import { UpdatePlatformSiteBody } from "@workspace/api-zod";

test("site update contract accepts complete locations and an explicit location clear", () => {
  const update = UpdatePlatformSiteBody.parse({
    siteName: "Northline Plant",
    organizationId: "organization-1",
    timezone: "Asia/Kolkata",
    latitude: 12.9716,
    longitude: 77.5946,
  });
  assert.equal(update.latitude, 12.9716);
  assert.equal(update.longitude, 77.5946);

  const clear = UpdatePlatformSiteBody.parse({
    siteName: "Northline Plant",
    latitude: null,
    longitude: null,
  });
  assert.equal(clear.latitude, null);
  assert.equal(clear.longitude, null);
});

test("site update contract rejects invalid coordinate bounds", () => {
  assert.throws(() => UpdatePlatformSiteBody.parse({
    siteName: "Northline Plant",
    latitude: 91,
    longitude: 77.5946,
  }));
  assert.throws(() => UpdatePlatformSiteBody.parse({
    siteName: "Northline Plant",
    latitude: 12.9716,
    longitude: 181,
  }));
});