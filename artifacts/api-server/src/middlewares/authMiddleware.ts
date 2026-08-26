import type { NextFunction, Request, Response } from "express";
import * as oidc from "openid-client";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  clearScadaSession,
  clearSession,
  getOidcConfig,
  getScadaSessionId,
  getScadaSessionUserId,
  getSession,
  getSessionId,
  setScadaSessionCookie,
  toAuthUser,
  updateSession,
  type AuthUser,
  type SessionData,
} from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      scadaUser?: AuthUser;
      isAuthenticated(): this is Request & { user: AuthUser };
      isScadaAuthenticated(): this is Request & { scadaUser: AuthUser };
    }
  }
}

async function refreshSession(sid: string, session: SessionData) {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expiresAt || now <= session.expiresAt) return session;
  if (!session.refreshToken) return null;
  try {
    const tokens = await oidc.refreshTokenGrant(await getOidcConfig(), session.refreshToken);
    const refreshed: SessionData = {
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: tokens.expiresIn() ? now + tokens.expiresIn()! : session.expiresAt,
    };
    await updateSession(sid, refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  req.isAuthenticated = function (this: Request) {
    return this.user !== undefined;
  } as Request["isAuthenticated"];
  req.isScadaAuthenticated = function (this: Request) {
    return this.scadaUser !== undefined;
  } as Request["isScadaAuthenticated"];
  const oidcSid = getSessionId(req);
  if (oidcSid) {
    const session = await getSession(oidcSid);
    const refreshed = session?.user?.id ? await refreshSession(oidcSid, session) : null;
    if (refreshed) {
      const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, refreshed.user.id)).limit(1);
      if (currentUser?.accountStatus === "active") {
        req.user = toAuthUser(currentUser);
      }
    }
    if (!req.user) await clearSession(res, oidcSid);
  }

  const scadaSid = getScadaSessionId(req);
  if (scadaSid) {
    const userId = await getScadaSessionUserId(scadaSid);
    const [currentUser] = userId
      ? await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1)
      : [];
    if (currentUser?.accountStatus === "active") {
      req.scadaUser = toAuthUser(currentUser);
      req.user ??= req.scadaUser;
      // Keep the persistent operator session alive while the app is actively
      // being used, without sharing or extending the Platform Admin session.
      setScadaSessionCookie(res, scadaSid);
    } else {
      await clearScadaSession(res, scadaSid);
    }
  }
  next();
}

export function requireScadaSession(req: Request, res: Response, next: NextFunction) {
  if (req.isScadaAuthenticated()) {
    next();
    return;
  }
  res.status(401).json({ message: "SCADA operator sign-in is required." });
}