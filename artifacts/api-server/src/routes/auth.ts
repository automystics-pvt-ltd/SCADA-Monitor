import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  clearScadaSession,
  clearSession,
  createScadaSession,
  createSession,
  getOidcConfig,
  getScadaSessionId,
  getSessionId,
  normalizeScadaUsername,
  setScadaSessionCookie,
  toAuthUser,
  verifyScadaPassword,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type AuthUser,
  type SessionData,
} from "../lib/auth";
import { isPlantLocationAdministrator } from "../middlewares/plantLocationAuthorization";

const router: IRouter = Router();
const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; expiresAt: number }>();

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

function loginAttemptKey(req: Request, username: string) {
  return `${req.ip}:${username}`;
}

function loginIsRateLimited(key: string) {
  const record = loginAttempts.get(key);
  if (!record) return false;
  if (record.expiresAt <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(key: string) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  loginAttempts.set(key, {
    count: current && current.expiresAt > now ? current.count + 1 : 1,
    expiresAt: now + LOGIN_ATTEMPT_WINDOW_MS,
  });
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
  return toAuthUser(saved);
}

router.get("/auth/user", (req, res) => {
  // req.user is already narrowed to AuthUser by authMiddleware (no
  // passwordHash/passwordSetAt), but re-narrow here too so this response
  // can never leak credential material even if that invariant changes.
  const user = req.isAuthenticated() ? toAuthUser(req.user) : null;
  res.set("Cache-Control", "no-store").json({
    user,
    canUpdatePlantLocations: isPlantLocationAdministrator(user ?? undefined),
  });
});

router.get("/scada-auth/user", (req, res) => {
  const user = req.isScadaAuthenticated() ? toAuthUser(req.scadaUser) : null;
  res.set("Cache-Control", "no-store").json({
    user,
    canUpdatePlantLocations: isPlantLocationAdministrator(user ?? undefined),
  });
});

router.post("/scada-auth/login", async (req: Request, res: Response): Promise<void> => {
  const rawUsername = typeof req.body?.username === "string" ? req.body.username : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const username = normalizeScadaUsername(rawUsername);
  if (!username || password.length < 8 || password.length > 256) {
    res.status(401).json({ error: "The username or password is incorrect." });
    return;
  }
  const attemptKey = loginAttemptKey(req, username);
  if (loginIsRateLimited(attemptKey)) {
    res.status(429).json({ error: "Too many unsuccessful sign-in attempts. Try again in 15 minutes." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  const passwordValid = Boolean(user?.passwordHash) && await verifyScadaPassword(password, user.passwordHash!);
  if (!user || user.accountStatus !== "active" || !passwordValid) {
    recordFailedLogin(attemptKey);
    res.status(401).json({ error: "The username or password is incorrect." });
    return;
  }
  loginAttempts.delete(attemptKey);
  setScadaSessionCookie(res, await createScadaSession(user.id));
  res.set("Cache-Control", "no-store").json({
    user: {
      id: user.id,
      username: user.username,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
    },
  });
});

router.post("/scada-auth/logout", async (req: Request, res: Response): Promise<void> => {
  await clearScadaSession(res, getScadaSessionId(req));
  res.status(204).end();
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