import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, platformSiteAccessTable } from "@workspace/db";
import { canAccessSite, canAccessSiteRole, resolveSiteAccess, type ScadaSiteAccess, type SiteGrant } from "./platformSiteAccessPolicy";

const globalAccessEnabled = () => process.env.SCADA_ALLOW_GLOBAL_ACCESS === "true";

export async function siteAccess(req: Request): Promise<ScadaSiteAccess> {
  if (!req.isAuthenticated()) return resolveSiteAccess(false, [], globalAccessEnabled());
  const grants = await db
    .select({ siteName: platformSiteAccessTable.siteName, role: platformSiteAccessTable.role, status: platformSiteAccessTable.status })
    .from(platformSiteAccessTable)
    .where(and(
      eq(platformSiteAccessTable.userId, req.user.id),
      eq(platformSiteAccessTable.status, "active"),
    ));
  return resolveSiteAccess(true, grants, globalAccessEnabled());
}

export async function grantedSiteNames(req: Request): Promise<Set<string> | null> {
  const access = await siteAccess(req);
  return access.global ? null : access.sites;
}

export async function allowGrantedSite(req: Request, res: Response, siteName: string) {
  const access = await siteAccess(req);
  if (canAccessSite(access, siteName)) return true;
  res.status(403).json({ message: "Your assigned site access does not include this plant." });
  return false;
}

export async function allowSiteRole(
  req: Request,
  res: Response,
  siteName: string,
  allowed: Array<"viewer" | "operator" | "site-admin">,
) {
  const access = await siteAccess(req);
  if (canAccessSiteRole(access, siteName, allowed)) return true;
  res.status(403).json({ message: `This action requires ${allowed.join(" or ")} access for the selected site.` });
  return false;
}

export async function allowUnscopedScadaEvidence(req: Request, res: Response) {
  const access = await siteAccess(req);
  if (access.global) return true;
  res.status(403).json({
    message: "Select one of your assigned sites before opening this evidence feed.",
  });
  return false;
}