import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import {
  db,
  platformAdminIdentitiesTable,
  platformAdminSessionsTable,
  usersTable,
} from "@workspace/db";
import { getOidcConfig } from "../lib/auth";
import {
  PLATFORM_ADMIN_SESSION_TTL_MS,
  clearPlatformAdminSessionCookie,
  setPlatformAdminSessionCookie,
} from "../middlewares/platformAdminAuthorization";

const router: IRouter = Router();
const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;

function requestOrigin(req: Request) {
  const proto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "https";
  const host = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function safeReturnTo(value: unknown) {
  return typeof value === "string" && value.startsWith("/platform-admin/") && !value.startsWith("//")
    ? value
    : "/platform-admin/";
}

function setTemporaryCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: OIDC_COOKIE_TTL_MS });
}

function adminAllowlist() {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function upsertIdentity(claims: Record<string, unknown>) {
  const user = {
    id: String(claims.sub),
    email: typeof claims.email === "string" ? claims.email : null,
    firstName: typeof claims.first_name === "string" ? claims.first_name : null,
    lastName: typeof claims.last_name === "string" ? claims.last_name : null,
    profileImageUrl: typeof (claims.profile_image_url ?? claims.picture) === "string" ? String(claims.profile_image_url ?? claims.picture) : null,
  };
  if (!user.email || !adminAllowlist().has(user.email.toLowerCase())) return null;
  const [savedUser] = await db.insert(usersTable).values(user).onConflictDoUpdate({
    target: usersTable.id,
    set: { ...user, updatedAt: new Date() },
  }).returning();
  const [identity] = await db.insert(platformAdminIdentitiesTable)
    .values({ userId: savedUser.id, role: "super-admin", enabled: true })
    .onConflictDoUpdate({
      target: platformAdminIdentitiesTable.userId,
      set: { enabled: true, updatedAt: new Date() },
    })
    .returning();
  return identity;
}

router.get("/platform-admin/login", async (req: Request, res: Response): Promise<void> => {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const url = oidc.buildAuthorizationUrl(await getOidcConfig(), {
    redirect_uri: `${requestOrigin(req)}/api/platform-admin/callback`,
    scope: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  setTemporaryCookie(res, "platform_oidc_verifier", verifier);
  setTemporaryCookie(res, "platform_oidc_nonce", nonce);
  setTemporaryCookie(res, "platform_oidc_state", state);
  setTemporaryCookie(res, "platform_return_to", safeReturnTo(req.query.returnTo));
  res.redirect(url.href);
});

router.get("/platform-admin/callback", async (req: Request, res: Response): Promise<void> => {
  const verifier = req.cookies?.platform_oidc_verifier;
  const expectedState = req.cookies?.platform_oidc_state;
  if (!verifier || !expectedState) {
    res.redirect("/platform-admin/?access=retry");
    return;
  }
  const callbackUrl = `${requestOrigin(req)}/api/platform-admin/callback`;
  const currentUrl = new URL(`${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`);
  const clearTemporaryCookies = () => {
    for (const cookie of ["platform_oidc_verifier", "platform_oidc_nonce", "platform_oidc_state", "platform_return_to"]) {
      res.clearCookie(cookie, { path: "/" });
    }
  };
  try {
    const tokens = await oidc.authorizationCodeGrant(await getOidcConfig(), currentUrl, {
      pkceCodeVerifier: verifier,
      expectedNonce: req.cookies?.platform_oidc_nonce,
      expectedState,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const identity = claims ? await upsertIdentity(claims as unknown as Record<string, unknown>) : null;
    if (!identity) {
      clearTemporaryCookies();
      res.redirect("/platform-admin/?access=denied");
      return;
    }
    const sid = crypto.randomBytes(32).toString("hex");
    await db.insert(platformAdminSessionsTable).values({
      sid,
      adminIdentityId: identity.id,
      expire: new Date(Date.now() + PLATFORM_ADMIN_SESSION_TTL_MS),
    });
    setPlatformAdminSessionCookie(res, sid);
    clearTemporaryCookies();
    res.redirect(safeReturnTo(req.cookies?.platform_return_to));
  } catch {
    clearTemporaryCookies();
    res.redirect("/platform-admin/?access=retry");
  }
});

router.get("/platform-admin/logout", async (req: Request, res: Response): Promise<void> => {
  const sid = req.cookies?.platform_admin_sid;
  if (typeof sid === "string") {
    await db.delete(platformAdminSessionsTable).where(eq(platformAdminSessionsTable.sid, sid));
  }
  clearPlatformAdminSessionCookie(res);
  res.redirect(safeReturnTo(req.query.returnTo));
});

export default router;