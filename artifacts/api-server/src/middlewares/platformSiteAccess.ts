import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, platformConfigurationTable, platformSiteAccessTable, platformSitesTable } from "@workspace/db";
import { canAccessSite, canAccessSitePermission, canAccessSiteRole, resolveSiteAccess, type RolePermissionsConfig, type ScadaPermission, type ScadaSiteAccess, type SiteGrant } from "./platformSiteAccessPolicy";

const globalAccessEnabled = () => process.env.SCADA_ALLOW_GLOBAL_ACCESS === "true";

export async function siteAccess(req: Request): Promise<ScadaSiteAccess> {
  if (!req.isAuthenticated()) return resolveSiteAccess(false, [], globalAccessEnabled());
  const [grants, configuration] = await Promise.all([
    db
    .select({
      siteName: platformSiteAccessTable.siteName,
      role: platformSiteAccessTable.role,
      status: platformSiteAccessTable.status,
    })
    .from(platformSiteAccessTable)
    .innerJoin(platformSitesTable, eq(platformSiteAccessTable.siteName, platformSitesTable.siteName))
    .where(and(
      eq(platformSiteAccessTable.userId, req.user.id),
      eq(platformSiteAccessTable.status, "active"),
      eq(platformSitesTable.status, "active"),
    )),
    db.select({ value: platformConfigurationTable.value }).from(platformConfigurationTable).where(eq(platformConfigurationTable.key, "role-permissions")).limit(1),
  ]);
  const permissions = configuration[0]?.value && typeof configuration[0].value === "object" && !Array.isArray(configuration[0].value)
    ? configuration[0].value as RolePermissionsConfig
    : undefined;
  // Assignment and activation are intentionally separate: return an assigned
  // inactive site so the client can explain its state, while allowGrantedSite
  // remains the single activation-aware gate for all telemetry/evidence routes.
  return resolveSiteAccess(true, grants
    .map(({ siteName, role, status }) => ({ siteName, role, status })), globalAccessEnabled(), permissions);
  // Permission configuration is intentionally loaded with the access query so
  // every protected request observes the current administrator policy.
}

export async function grantedSiteNames(req: Request): Promise<Set<string> | null> {
  const access = await siteAccess(req);
  return access.global ? null : access.sites;
}

export async function allowGrantedSite(req: Request, res: Response, siteName: string) {
  const access = await siteAccess(req);
  if (!canAccessSite(access, siteName)) {
    res.status(403).json({ message: "Your assigned site access does not include this plant." });
    return false;
  }
  const [managedSite] = await db
    .select({ activationStatus: platformSitesTable.activationStatus, status: platformSitesTable.status })
    .from(platformSitesTable)
    .where(eq(platformSitesTable.siteName, siteName))
    .limit(1);
  if (!managedSite || managedSite.status !== "active") {
    res.status(403).json({ message: "This managed site is archived and is not available for SCADA operations." });
    return false;
  }
  if (managedSite.activationStatus === "active") return true;
  res.status(403).json({ message: "This managed site is inactive. A platform administrator must activate it before telemetry can be opened." });
  return false;
}

export async function allowSiteRole(
  req: Request,
  res: Response,
  siteName: string,
  allowed: Array<"viewer" | "operator" | "site-engineer" | "site-admin">,
) {
  const access = await siteAccess(req);
  if (canAccessSiteRole(access, siteName, allowed)) return true;
  res.status(403).json({ message: `This action requires ${allowed.join(" or ")} access for the selected site.` });
  return false;
}

export async function allowSitePermission(req: Request, res: Response, siteName: string, permission: ScadaPermission) {
  const access = await siteAccess(req);
  if (canAccessSitePermission(access, siteName, permission)) return true;
  res.status(403).json({ message: `Your role does not include ${permission} access for the selected site.` });
  return false;
}

export async function allowUnscopedScadaEvidence(req: Request, res: Response) {
  res.status(403).json({
    message: "Select an active managed site before opening this evidence feed.",
  });
  return false;
}