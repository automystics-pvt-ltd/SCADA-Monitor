import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, platformSiteAccessTable } from "@workspace/db";

const globalAccessEnabled = () => process.env.SCADA_ALLOW_GLOBAL_ACCESS === "true";

export type ScadaSiteAccess = {
  sites: Set<string>;
  roles: Map<string, "viewer" | "operator" | "site-admin">;
  global: boolean;
};

export async function siteAccess(req: Request): Promise<ScadaSiteAccess> {
  if (!req.isAuthenticated()) return { sites: new Set(), roles: new Map(), global: globalAccessEnabled() };
  const grants = await db
    .select({ siteName: platformSiteAccessTable.siteName, role: platformSiteAccessTable.role })
    .from(platformSiteAccessTable)
    .where(and(
      eq(platformSiteAccessTable.userId, req.user.id),
      eq(platformSiteAccessTable.status, "active"),
    ));
  return {
    sites: new Set(grants.map((grant) => grant.siteName)),
    roles: new Map(grants.map((grant) => [grant.siteName, grant.role])),
    global: grants.length === 0 && globalAccessEnabled(),
  };
}

export async function grantedSiteNames(req: Request): Promise<Set<string> | null> {
  const access = await siteAccess(req);
  return access.global ? null : access.sites;
}

export async function allowGrantedSite(req: Request, res: Response, siteName: string) {
  const access = await siteAccess(req);
  if (access.global || access.sites.has(siteName)) return true;
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
  if (access.global || allowed.includes(access.roles.get(siteName) ?? "viewer")) return true;
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