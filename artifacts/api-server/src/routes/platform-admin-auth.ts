import crypto from "crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import * as oidc from "openid-client";
import nodemailer from "nodemailer";
import {
  db,
  platformAdminOtpChallengesTable,
  platformAdminIdentitiesTable,
  platformAuditEventsTable,
  platformAdminSessionsTable,
  usersTable,
} from "@workspace/db";
import {
  PLATFORM_ADMIN_SESSION_TTL_MS,
  clearPlatformAdminSessionCookie,
  setPlatformAdminSessionCookie,
} from "../middlewares/platformAdminAuthorization";
import { isAllowedPlatformAdminEmail, safeReturnTo, sessionIdForLogout } from "./platform-admin-auth-policy";

const router: IRouter = Router();
const OIDC_COOKIE_TTL_MS = 10 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_REQUEST_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const GOOGLE_ISSUER = new URL("https://accounts.google.com");
let googleOidcConfig: oidc.Configuration | null = null;

function requestOrigin(req: Request) {
  const proto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "https";
  const host = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function setTemporaryCookie(res: Response, name: string, value: string) {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: OIDC_COOKIE_TTL_MS });
}

function googleClientConfig() {
  const clientId = process.env.PLATFORM_ADMIN_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.PLATFORM_ADMIN_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("Google Platform Admin credentials are not configured.");
  return { clientId, clientSecret };
}

async function getGoogleOidcConfig() {
  if (!googleOidcConfig) {
    const { clientId, clientSecret } = googleClientConfig();
    googleOidcConfig = await oidc.discovery(GOOGLE_ISSUER, clientId, clientSecret);
  }
  return googleOidcConfig;
}

function claimString(claims: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (typeof claims[key] === "string" && claims[key].trim()) return claims[key].trim();
  }
  return undefined;
}

async function upsertIdentity(claims: Record<string, unknown>) {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
  if (!email || !isAllowedPlatformAdminEmail(email)) return null;

  const [provisionedUser] = email
    ? await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1)
    : [];
  if (!provisionedUser || provisionedUser.accountStatus !== "active") return null;

  const userUpdates: {
    email: string;
    firstName?: string;
    lastName?: string;
    profileImageUrl?: string;
    updatedAt: Date;
  } = { email, updatedAt: new Date() };
  const firstName = claimString(claims, "first_name", "given_name");
  const lastName = claimString(claims, "last_name", "family_name");
  const profileImageUrl = claimString(claims, "profile_image_url", "picture");
  if (firstName) userUpdates.firstName = firstName;
  if (lastName) userUpdates.lastName = lastName;
  if (profileImageUrl) userUpdates.profileImageUrl = profileImageUrl;
  const [savedUser] = await db.update(usersTable).set(userUpdates).where(eq(usersTable.id, provisionedUser.id)).returning();

  const [existingIdentity] = await db
    .select()
    .from(platformAdminIdentitiesTable)
    .where(eq(platformAdminIdentitiesTable.userId, savedUser.id))
    .limit(1);
  if (existingIdentity && !existingIdentity.enabled) return null;
  const identity = existingIdentity ?? (await db.insert(platformAdminIdentitiesTable)
    .values({ userId: savedUser.id, role: "super-admin", enabled: true })
    .returning())[0];
  return identity;
}

async function recordAdminLogin(identity: typeof platformAdminIdentitiesTable.$inferSelect, email: string, method: "google" | "otp") {
  await db.insert(platformAuditEventsTable).values({
    actorUserId: identity.userId,
    actorEmail: email,
    action: "platform-admin.login",
    targetType: "platform-admin-session",
    targetId: identity.id,
    metadata: { method },
  });
}

async function createAdminSession(identity: typeof platformAdminIdentitiesTable.$inferSelect, email: string, method: "google" | "otp", res: Response) {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(platformAdminSessionsTable).values({
    sid,
    adminIdentityId: identity.id,
    expire: new Date(Date.now() + PLATFORM_ADMIN_SESSION_TTL_MS),
  });
  await recordAdminLogin(identity, email, method);
  setPlatformAdminSessionCookie(res, sid);
}

function otpDigest(challengeId: string, code: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for Platform Admin OTP.");
  return crypto.createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("hex");
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function smtpTransport() {
  const user = process.env.PLATFORM_ADMIN_SMTP_USERNAME?.trim();
  const pass = process.env.PLATFORM_ADMIN_SMTP_PASSWORD;
  if (!user || !pass) throw new Error("Gmail SMTP credentials are not configured.");
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user, pass },
    tls: { minVersion: "TLSv1.2" },
  });
}

async function sendAdminOtp(email: string, code: string) {
  const from = process.env.PLATFORM_ADMIN_SMTP_USERNAME?.trim();
  await smtpTransport().sendMail({
    from: from ? `"SCADA Platform Admin" <${from}>` : undefined,
    to: email,
    subject: "Your SCADA Platform Admin sign-in code",
    text: `Your Platform Admin sign-in code is ${code}. It expires in 10 minutes and can only be used once.`,
  });
}

router.get("/platform-admin/login", (req: Request, res: Response): void => {
  const returnTo = safeReturnTo(req.query.returnTo);
  res.redirect(`/api/platform-admin/google/login?returnTo=${encodeURIComponent(returnTo)}`);
});

router.get("/platform-admin/google/login", async (req: Request, res: Response): Promise<void> => {
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const url = oidc.buildAuthorizationUrl(await getGoogleOidcConfig(), {
    redirect_uri: `${requestOrigin(req)}/api/platform-admin/google/callback`,
    scope: "openid email profile",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  setTemporaryCookie(res, "platform_google_verifier", verifier);
  setTemporaryCookie(res, "platform_google_nonce", nonce);
  setTemporaryCookie(res, "platform_google_state", state);
  setTemporaryCookie(res, "platform_return_to", safeReturnTo(req.query.returnTo));
  res.redirect(url.href);
});

router.get("/platform-admin/google/callback", async (req: Request, res: Response): Promise<void> => {
  const verifier = req.cookies?.platform_google_verifier;
  const expectedState = req.cookies?.platform_google_state;
  if (!verifier || !expectedState) {
    res.redirect("/platform-admin/?access=retry");
    return;
  }
  const callbackUrl = `${requestOrigin(req)}/api/platform-admin/google/callback`;
  const currentUrl = new URL(`${callbackUrl}?${new URL(req.url, `http://${req.headers.host}`).searchParams}`);
  const clearTemporaryCookies = () => {
    for (const cookie of ["platform_google_verifier", "platform_google_nonce", "platform_google_state", "platform_return_to"]) {
      res.clearCookie(cookie, { path: "/" });
    }
  };
  try {
    const tokens = await oidc.authorizationCodeGrant(await getGoogleOidcConfig(), currentUrl, {
      pkceCodeVerifier: verifier,
      expectedNonce: req.cookies?.platform_google_nonce,
      expectedState,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    const claimRecord = claims as unknown as Record<string, unknown>;
    const googleEmailVerified = claimRecord.email_verified === true || claimRecord.email_verified === "true";
    const identity = googleEmailVerified ? await upsertIdentity(claimRecord) : null;
    if (!identity) {
      clearTemporaryCookies();
      res.redirect("/platform-admin/?access=denied");
      return;
    }
    const email = claimRecord.email as string;
    await createAdminSession(identity, email, "google", res);
    clearTemporaryCookies();
    res.redirect(safeReturnTo(req.cookies?.platform_return_to));
  } catch {
    clearTemporaryCookies();
    res.redirect("/platform-admin/?access=retry");
  }
});

router.post("/platform-admin/otp/request", async (req: Request, res: Response): Promise<void> => {
  const email = normalizeEmail(req.body?.email);
  if (!email || !isAllowedPlatformAdminEmail(email)) {
    res.json({ message: "If this email is eligible, a one-time code will be sent." });
    return;
  }

  const [recent] = await db
    .select({ createdAt: platformAdminOtpChallengesTable.createdAt })
    .from(platformAdminOtpChallengesTable)
    .where(eq(platformAdminOtpChallengesTable.email, email))
    .orderBy(desc(platformAdminOtpChallengesTable.createdAt))
    .limit(1);
  if (recent && Date.now() - recent.createdAt.getTime() < OTP_REQUEST_COOLDOWN_MS) {
    res.status(429).json({ message: "Please wait before requesting another code." });
    return;
  }

  await db.delete(platformAdminOtpChallengesTable).where(and(
    eq(platformAdminOtpChallengesTable.email, email),
    isNull(platformAdminOtpChallengesTable.consumedAt),
    gt(platformAdminOtpChallengesTable.expiresAt, new Date()),
  ));

  const id = crypto.randomBytes(24).toString("hex");
  const code = crypto.randomInt(100000, 1000000).toString();
  await db.insert(platformAdminOtpChallengesTable).values({
    id,
    email,
    codeHash: otpDigest(id, code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });

  try {
    await sendAdminOtp(email, code);
  } catch {
    await db.delete(platformAdminOtpChallengesTable).where(eq(platformAdminOtpChallengesTable.id, id));
    res.status(503).json({ message: "The sign-in code could not be sent. Please try again shortly." });
    return;
  }

  res.json({ challengeId: id, message: "A one-time sign-in code was sent to the eligible administrator email." });
});

router.post("/platform-admin/otp/verify", async (req: Request, res: Response): Promise<void> => {
  const email = normalizeEmail(req.body?.email);
  const challengeId = typeof req.body?.challengeId === "string" ? req.body.challengeId.trim() : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!email || !challengeId || !/^\d{6}$/.test(code)) {
    res.status(400).json({ message: "Enter the six-digit sign-in code." });
    return;
  }

  const [challenge] = await db
    .select()
    .from(platformAdminOtpChallengesTable)
    .where(and(eq(platformAdminOtpChallengesTable.id, challengeId), eq(platformAdminOtpChallengesTable.email, email)))
    .limit(1);
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date() || challenge.attemptCount >= OTP_MAX_ATTEMPTS) {
    res.status(401).json({ message: "That sign-in code is invalid or expired." });
    return;
  }

  const expected = Buffer.from(challenge.codeHash, "hex");
  const actual = Buffer.from(otpDigest(challenge.id, code), "hex");
  const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!valid) {
    await db.update(platformAdminOtpChallengesTable)
      .set({ attemptCount: challenge.attemptCount + 1 })
      .where(and(eq(platformAdminOtpChallengesTable.id, challenge.id), isNull(platformAdminOtpChallengesTable.consumedAt)));
    res.status(401).json({ message: "That sign-in code is invalid or expired." });
    return;
  }

  const [consumedChallenge] = await db.update(platformAdminOtpChallengesTable)
    .set({ consumedAt: new Date(), attemptCount: challenge.attemptCount + 1 })
    .where(and(
      eq(platformAdminOtpChallengesTable.id, challenge.id),
      isNull(platformAdminOtpChallengesTable.consumedAt),
      gt(platformAdminOtpChallengesTable.expiresAt, new Date()),
    ))
    .returning({ id: platformAdminOtpChallengesTable.id });
  if (!consumedChallenge) {
    res.status(401).json({ message: "That sign-in code is invalid or expired." });
    return;
  }

  const identity = await upsertIdentity({ email });
  if (!identity) {
    res.status(403).json({ message: "This administrator account is not enabled." });
    return;
  }

  await createAdminSession(identity, email, "otp", res);
  res.json({ ok: true });
});

router.get("/platform-admin/logout", async (req: Request, res: Response): Promise<void> => {
  const sid = req.cookies?.platform_admin_sid;
  const sessionId = sessionIdForLogout(sid);
  if (sessionId) {
    await db.delete(platformAdminSessionsTable).where(eq(platformAdminSessionsTable.sid, sessionId));
  }
  clearPlatformAdminSessionCookie(res);
  res.redirect(safeReturnTo(req.query.returnTo));
});

export default router;