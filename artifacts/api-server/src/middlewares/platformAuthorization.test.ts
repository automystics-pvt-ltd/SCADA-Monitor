import assert from "node:assert/strict";
import test from "node:test";
import { canAccessSite, canAccessSiteRole, resolveSiteAccess } from "./platformSiteAccessPolicy.ts";
import { isPlatformAdmin, platformAdminDenial } from "./platformAuthorizationPolicy.ts";
import { isAllowedPlatformAdminEmail, safeReturnTo, sessionIdForLogout } from "../routes/platform-admin-auth-policy.ts";

test("admin email allowlist is case-insensitive and rejects missing or unlisted emails", () => {
  const previous = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = " Admin@Example.com,ops@example.com ";
  try {
    assert.equal(isAllowedPlatformAdminEmail("admin@example.com"), true);
    assert.equal(isAllowedPlatformAdminEmail(" OPS@EXAMPLE.COM "), true);
    assert.equal(isAllowedPlatformAdminEmail("other@example.com"), false);
    assert.equal(isAllowedPlatformAdminEmail(undefined), false);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = previous;
  }
});

test("admin return paths cannot escape the platform-admin area", () => {
  assert.equal(safeReturnTo("/platform-admin/sites"), "/platform-admin/sites");
  assert.equal(safeReturnTo("/platform-admin/"), "/platform-admin/");
  assert.equal(safeReturnTo("//evil.example"), "/platform-admin/");
  assert.equal(safeReturnTo("/api/platform-admin/callback"), "/platform-admin/");
  assert.equal(safeReturnTo(undefined), "/platform-admin/");
});

test("logout only deletes a real platform-admin session and always has a safe target", () => {
  assert.equal(sessionIdForLogout("session-123"), "session-123");
  assert.equal(sessionIdForLogout(""), null);
  assert.equal(sessionIdForLogout(undefined), null);
  assert.equal(safeReturnTo("/platform-admin/access"), "/platform-admin/access");
});

test("protected admin APIs deny anonymous requests and allow an admin principal", () => {
  assert.deepEqual(platformAdminDenial(undefined), {
    status: 401,
    body: { error: "Platform administrator sign-in is required." },
  });
  assert.equal(isPlatformAdmin(undefined), false);
  const principal = {
    identityId: "identity",
  };
  assert.equal(isPlatformAdmin(principal), true);
  assert.equal(platformAdminDenial(principal), null);
});

test("grant and revoke state controls site and role access, while legacy global access remains explicit", () => {
  const assigned = resolveSiteAccess(true, [
    { siteName: "north", role: "operator", status: "active" },
    { siteName: "south", role: "site-admin", status: "revoked" },
  ], true);
  assert.equal(canAccessSite(assigned, "north"), true);
  assert.equal(canAccessSiteRole(assigned, "north", ["operator"]), true);
  assert.equal(canAccessSite(assigned, "south"), false);
  assert.equal(canAccessSiteRole(assigned, "south", ["site-admin"]), false);
  assert.equal(assigned.global, false);

  const legacy = resolveSiteAccess(true, [], true);
  assert.equal(legacy.global, true);
  assert.equal(canAccessSite(legacy, "unmanaged-site"), true);

  const anonymous = resolveSiteAccess(false, [], true);
  assert.equal(anonymous.sites.size, 0);
  assert.equal(anonymous.global, true);
});