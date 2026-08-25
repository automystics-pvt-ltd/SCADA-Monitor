import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { clearSession, createSession, getOidcConfig, getSessionId, SESSION_COOKIE, SESSION_TTL_MS, type AuthUser, type SessionData } from "../lib/auth";
import { isPlantLocationAdministrator } from "../middlewares/plantLocationAuthorization";

const router: IRouter = Router();
const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;

function requestOrigin(req: Request) {
  const proto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "https";
  const host = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function safeReturnTo(value: unknown) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function setTemporaryCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: OIDC_COOKIE_TTL_MS });
}

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS });
}

async function upsertUser(claims: Record<string, unknown>): Promise<AuthUser> {
  const identity = {
    id: String(claims.sub),
    email: typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null,
    firstName: typeof claims.first_name === "string" ? claims.first_name : null,
    lastName: typeof claims.last_name === "string" ? claims.last_name : null,
    profileImageUrl: typeof (claims.profile_image_url ?? claims.picture) === "string" ? String(claims.profile_image_url ?? claims.picture) : null,
  };
  const [existing] = identity.email
    ? await db.select().from(usersTable).where(eq(usersTable.email, identity.email)).limit(1)
    : [];
  if (!existing) throw new Error("This SCADA account has not been provisioned by a Platform Administrator.");
  if (existing.accountStatus !== "active") throw new Error("This SCADA account is inactive.");
  const [saved] = await db.update(usersTable).set({
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
    profileImageUrl: identity.profileImageUrl,
    updatedAt: new Date(),
  }).where(eq(usersTable.id, existing.id)).returning();
  if (!saved) throw new Error("The provisioned SCADA account could not be loaded.");
  return saved;
}

router.get("/auth/user", (req, res) => {
  const user = req.isAuthenticated() ? req.user : null;
  res.set("Cache-Control", "no-store").json({
    user,
    canUpdatePlantLocations: isPlantLocationAdministrator(user ?? undefined),
  });
});

router.get("/login", async (req: Request, res: Response): Promise<void> => {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const url = oidc.buildAuthorizationUrl(await getOidcConfig(), {
    redirect_uri: `${requestOrigin(req)}/api/callback`,
    scope: "openid email profile offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  setTemporaryCookie(res, "oidc_verifier", verifier);
  setTemporaryCookie(res, "oidc_nonce", nonce);
  setTemporaryCookie(res, "oidc_state", state);
  setTemporaryCookie(res, "return_to", safeReturnTo(req.query.returnTo));
  res.redirect(url.href);
});

router.get("/callback", async (req: Request, res: Response): Promise<void> => {
  const verifier = req.cookies?.oidc_verifier;
  const expectedState = req.cookies?.oidc_state;
  if (!verifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }
  const callbackUrl = `${requestOrigin(req)}/api/callback`;
  const currentUrl = new URL(`${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`);
  try {
    const tokens = await oidc.authorizationCodeGrant(await getOidcConfig(), currentUrl, {
      pkceCodeVerifier: verifier,
      expectedNonce: req.cookies?.oidc_nonce,
      expectedState,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error("Missing identity claims");
    const session: SessionData = {
      user: await upsertUser(claims as unknown as Record<string, unknown>),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiresIn() ? Math.floor(Date.now() / 1000) + tokens.expiresIn()! : claims.exp,
    };
    setSessionCookie(res, await createSession(session));
    const returnTo = safeReturnTo(req.cookies?.return_to);
    for (const cookie of ["oidc_verifier", "oidc_nonce", "oidc_state", "return_to"]) res.clearCookie(cookie, { path: "/" });
    res.redirect(returnTo);
  } catch (error) {
    req.log.warn({ err: error instanceof Error ? error.name : "unknown" }, "Operator sign-in callback failed");
    res.redirect("/api/login");
  }
});

router.get("/logout", async (req: Request, res: Response): Promise<void> => {
  await clearSession(res, getSessionId(req));
  res.redirect(safeReturnTo(req.query.returnTo));
});

export default router;