import assert from "node:assert/strict";
import test from "node:test";
import { canAccessSite, resolveSiteAccess, type SiteGrant } from "./platformSiteAccessPolicy.ts";

const evidenceReads = [
  "/api/mqtt/snapshots",
  "/api/mqtt/snapshots/latest",
  "/api/mqtt/electrical-history",
  "/api/mqtt/inverter-energy-history",
  "/api/mqtt/inverter-measurements",
  "/api/mqtt/device-parameters",
  "/api/mqtt/reports",
  "/api/mqtt/communication-events",
  "/api/mqtt/stream",
] as const;

const assignedSite = "North Array";
const otherSite = "South Array";

function assertSiteScopedReadsDeny(access: ReturnType<typeof resolveSiteAccess>, siteName: string) {
  for (const route of evidenceReads) {
    assert.equal(
      canAccessSite(access, siteName),
      false,
      `${route} must deny access to ${siteName}`,
    );
  }
}

function assertAssignedSiteReadsAllow(access: ReturnType<typeof resolveSiteAccess>) {
  for (const route of evidenceReads) {
    assert.equal(
      canAccessSite(access, assignedSite),
      true,
      `${route} must allow the assigned site`,
    );
  }
}

const roles: SiteGrant["role"][] = ["viewer", "operator", "site-admin"];

for (const role of roles) {
  test(`${role} access cannot cross the assigned-site boundary for any SCADA evidence read`, () => {
    const access = resolveSiteAccess(true, [
      { siteName: assignedSite, role, status: "active" },
    ], true);

    assert.equal(access.global, false, "an authenticated user with a grant must never fall back to global access");
    assertAssignedSiteReadsAllow(access);
    assertSiteScopedReadsDeny(access, otherSite);
  });
}

test("multiple active grants remain isolated from every unassigned SCADA site", () => {
  const access = resolveSiteAccess(true, [
    { siteName: assignedSite, role: "viewer", status: "active" },
    { siteName: "West Array", role: "site-admin", status: "active" },
  ], true);

  assert.equal(access.global, false);
  assertAssignedSiteReadsAllow(access);
  assertSiteScopedReadsDeny(access, otherSite);
  assert.equal(canAccessSite(access, "West Array"), true);
});

test("revoked grants do not authorize SCADA evidence reads when another site is actively assigned", () => {
  const access = resolveSiteAccess(true, [
    { siteName: assignedSite, role: "operator", status: "active" },
    { siteName: otherSite, role: "site-admin", status: "revoked" },
  ], true);

  assert.equal(access.global, false, "an active grant disables global fallback");
  assertAssignedSiteReadsAllow(access);
  assertSiteScopedReadsDeny(access, otherSite);
});

for (const globalEnabled of [false, true]) {
  test(`anonymous SCADA evidence access follows the explicit global-access policy (${globalEnabled ? "enabled" : "disabled"})`, () => {
    const access = resolveSiteAccess(false, [], globalEnabled);

    assert.equal(access.global, globalEnabled);
    for (const route of evidenceReads) {
      assert.equal(
        canAccessSite(access, assignedSite),
        globalEnabled,
        `${route} must follow the anonymous global-access policy`,
      );
    }
  });
}