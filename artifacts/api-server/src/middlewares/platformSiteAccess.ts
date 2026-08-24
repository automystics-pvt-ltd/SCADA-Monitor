import { and, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, platformSiteAccessTable } from "@workspace/db";

/**
 * A SCADA user with no platform grants remains on the pre-existing, global
 * access path. Once an administrator assigns any site, every site-aware read
 * must resolve through those grants instead of silently falling back to the
 * global plant.
 */
export async function grantedSiteNames(req: Request): Promise<Set<string> | null> {
  if (!req.isAuthenticated()) return null;
  const grants = await db
    .select({ siteName: platformSiteAccessTable.siteName })
    .from(platformSiteAccessTable)
    .where(and(
      eq(platformSiteAccessTable.userId, req.user.id),
      eq(platformSiteAccessTable.status, "active"),
    ));
  return grants.length ? new Set(grants.map((grant) => grant.siteName)) : null;
}

export async function allowGrantedSite(req: Request, res: Response, siteName: string) {
  const granted = await grantedSiteNames(req);
  if (!granted || granted.has(siteName)) return true;
  res.status(403).json({ message: "Your assigned site access does not include this plant." });
  return false;
}

export async function allowUnscopedScadaEvidence(req: Request, res: Response) {
  const granted = await grantedSiteNames(req);
  if (!granted) return true;
  res.status(403).json({
    message: "This evidence feed is not site-scoped. Select one of your assigned sites in a site-aware view instead.",
  });
  return false;
}