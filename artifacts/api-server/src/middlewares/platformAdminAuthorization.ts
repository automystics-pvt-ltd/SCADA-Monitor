import { and, eq, gt } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  platformAdminIdentitiesTable,
  platformAdminSessionsTable,
  usersTable,
} from "@workspace/db";
import { isPlatformAdmin } from "./platformAuthorizationPolicy";

export const PLATFORM_ADMIN_SESSION_COOKIE = "platform_admin_sid";
export const PLATFORM_ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PlatformAdminPrincipal = {
  identityId: string;
  userId: string;
  email: string;
  name: string;
  role: "super-admin" | "admin";
};

declare global {
  namespace Express {
    interface Request {
      platformAdmin?: PlatformAdminPrincipal;
    }
  }
}

function clearPlatformAdminCookie(res: Response) {
  res.clearCookie(PLATFORM_ADMIN_SESSION_COOKIE, { path: "/" });
}

export async function platformAdminSessionMiddleware(req: Request, res: Response, next: NextFunction) {
  const sid = req.cookies?.[PLATFORM_ADMIN_SESSION_COOKIE];
  if (!sid || typeof sid !== "string") {
    next();
    return;
  }

  const [session] = await db
    .select({
      identityId: platformAdminIdentitiesTable.id,
      userId: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: platformAdminIdentitiesTable.role,
    })
    .from(platformAdminSessionsTable)
    .innerJoin(platformAdminIdentitiesTable, eq(platformAdminSessionsTable.adminIdentityId, platformAdminIdentitiesTable.id))
    .innerJoin(usersTable, eq(platformAdminIdentitiesTable.userId, usersTable.id))
    .where(and(
      eq(platformAdminSessionsTable.sid, sid),
      gt(platformAdminSessionsTable.expire, new Date()),
      eq(platformAdminIdentitiesTable.enabled, true),
      eq(usersTable.accountStatus, "active"),
    ));

  if (!session || !session.email) {
    await db.delete(platformAdminSessionsTable).where(eq(platformAdminSessionsTable.sid, sid));
    clearPlatformAdminCookie(res);
    next();
    return;
  }

  req.platformAdmin = {
    identityId: session.identityId,
    userId: session.userId,
    email: session.email,
    name: [session.firstName, session.lastName].filter(Boolean).join(" ") || session.email,
    role: session.role,
  };
  await db.update(platformAdminSessionsTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(platformAdminSessionsTable.sid, sid));
  next();
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isPlatformAdmin(req.platformAdmin)) {
    res.status(401).json({ error: "Platform administrator sign-in is required." });
    return;
  }
  next();
}

export function setPlatformAdminSessionCookie(res: Response, sid: string) {
  res.cookie(PLATFORM_ADMIN_SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: PLATFORM_ADMIN_SESSION_TTL_MS,
  });
}

export function clearPlatformAdminSessionCookie(res: Response) {
  clearPlatformAdminCookie(res);
}