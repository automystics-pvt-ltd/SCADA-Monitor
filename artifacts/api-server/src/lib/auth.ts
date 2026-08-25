import crypto from "crypto";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import * as client from "openid-client";
import { db, sessionsTable } from "@workspace/db";

export type AuthUser = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  accountStatus?: "active" | "inactive" | "deleted";
};

export type SessionData = {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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