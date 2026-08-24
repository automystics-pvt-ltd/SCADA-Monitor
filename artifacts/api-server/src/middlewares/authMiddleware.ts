import type { NextFunction, Request, Response } from "express";
import * as oidc from "openid-client";
import { clearSession, getOidcConfig, getSession, getSessionId, updateSession, type AuthUser, type SessionData } from "../lib/auth";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      isAuthenticated(): this is Request & { user: AuthUser };
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
  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }
  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    next();
    return;
  }
  const refreshed = await refreshSession(sid, session);
  if (!refreshed) {
    await clearSession(res, sid);
    next();
    return;
  }
  req.user = refreshed.user;
  next();
}