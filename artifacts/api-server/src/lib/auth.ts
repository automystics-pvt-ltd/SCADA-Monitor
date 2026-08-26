import crypto from "crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Request, Response } from "express";
import * as client from "openid-client";
import { db, scadaSessionsTable, sessionsTable } from "@workspace/db";
import { closeScadaSessionStreams } from "./scada-session-streams";

export type AuthUser = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  accountStatus?: "active" | "inactive" | "deleted";
};

// Narrows a full `users` DB row (which carries `passwordHash`/`passwordSetAt`
// credential material) down to the fields that are safe to hold on
// req.user/req.scadaUser and safe to ever serialize back to a browser.
// Always build AuthUser values through this so a route can't accidentally
// leak credential fields by forwarding the raw DB row.
export function toAuthUser(row: {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  accountStatus?: "active" | "inactive" | "deleted" | null;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    profileImageUrl: row.profileImageUrl,
    accountStatus: row.accountStatus ?? undefined,
  };
}

export type SessionData = {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SCADA_SESSION_COOKIE = "scada_sid";
// SCADA is a separate operator session, but returning operators should not
// need to re-enter credentials every workday. Account status, password
// changes, logout, and administrator revocation still invalidate the session.
export const SCADA_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const issuerUrl = process.env.ISSUER_URL ?? "https://replit.com/oidc";
let oidcConfig: client.Configuration | null = null;

export async function getOidcConfig() {
  if (!oidcConfig) {
    if (!process.env.REPL_ID) throw new Error("REPL_ID is required for operator sign-in");
    oidcConfig = await client.discovery(new URL(issuerUrl), process.env.REPL_ID);
  }
  return oidcConfig;
}

export async function createSession(data: SessionData) {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL_MS),
  });
  return sid;
}

export async function getSession(sid: string) {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }
  return row.sess as unknown as SessionData;
}

export async function updateSession(sid: string, data: SessionData) {
  await db.update(sessionsTable).set({
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL_MS),
  }).where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string) {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string) {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionId(req: Request) {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return req.cookies?.[SESSION_COOKIE] as string | undefined;
}

export function normalizeScadaUsername(value: string) {
  const username = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) ? username : null;
}

export async function hashScadaPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyScadaPassword(password: string, storedHash: string) {
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  if (expectedBuffer.length !== 64) return false;
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return crypto.timingSafeEqual(expectedBuffer, derived);
}

export async function createScadaSession(userId: string) {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(scadaSessionsTable).values({
    sid,
    userId,
    expire: new Date(Date.now() + SCADA_SESSION_TTL_MS),
  });
  return sid;
}

export async function getScadaSessionUserId(sid: string) {
  const [session] = await db
    .select({ userId: scadaSessionsTable.userId })
    .from(scadaSessionsTable)
    .where(and(eq(scadaSessionsTable.sid, sid), gt(scadaSessionsTable.expire, new Date())))
    .limit(1);
  if (!session) {
    await db.delete(scadaSessionsTable).where(eq(scadaSessionsTable.sid, sid));
    return null;
  }
  await db.update(scadaSessionsTable).set({
    lastSeenAt: new Date(),
    expire: new Date(Date.now() + SCADA_SESSION_TTL_MS),
  }).where(eq(scadaSessionsTable.sid, sid));
  return session.userId;
}

export async function clearScadaSession(res: Response, sid?: string) {
  if (sid) {
    closeScadaSessionStreams(sid);
    await db.delete(scadaSessionsTable).where(eq(scadaSessionsTable.sid, sid));
  }
  res.clearCookie(SCADA_SESSION_COOKIE, { path: "/" });
}

export function getScadaSessionId(req: Request) {
  return req.cookies?.[SCADA_SESSION_COOKIE] as string | undefined;
}

export function setScadaSessionCookie(res: Response, sid: string) {
  res.cookie(SCADA_SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SCADA_SESSION_TTL_MS,
  });
}