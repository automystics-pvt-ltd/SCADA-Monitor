export type SiteGrant = {
  siteName: string;
  role: "viewer" | "operator" | "site-admin";
  status: "active" | "revoked";
};

export type ScadaSiteAccess = {
  sites: Set<string>;
  roles: Map<string, "viewer" | "operator" | "site-admin">;
  global: boolean;
};

export function resolveSiteAccess(authenticated: boolean, grants: SiteGrant[], globalEnabled: boolean): ScadaSiteAccess {
  if (!authenticated) return { sites: new Set(), roles: new Map(), global: globalEnabled };
  const activeGrants = grants.filter((grant) => grant.status === "active");
  return {
    sites: new Set(activeGrants.map((grant) => grant.siteName)),
    roles: new Map(activeGrants.map((grant) => [grant.siteName, grant.role])),
    global: activeGrants.length === 0 && globalEnabled,
  };
}

export function canAccessSite(access: ScadaSiteAccess, siteName: string) {
  return access.global || access.sites.has(siteName);
}

export function canAccessSiteRole(access: ScadaSiteAccess, siteName: string, allowed: Array<"viewer" | "operator" | "site-admin">) {
  return access.global || allowed.includes(access.roles.get(siteName) ?? "viewer");
}