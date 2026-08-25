export type SiteGrant = {
  siteName: string;
  role: "viewer" | "operator" | "site-engineer" | "site-admin";
  status: "active" | "revoked";
};

export const SCADA_PERMISSIONS = [
  "dashboard",
  "live-monitoring",
  "inverter-details",
  "electrical-parameters",
  "energy-analytics",
  "mppt-strings",
  "alarms-faults",
  "historical-data",
  "scada-reports",
  "data-export",
  "site-configuration",
  "device-configuration",
  "user-management",
] as const;
export type ScadaPermission = typeof SCADA_PERMISSIONS[number];
export type RolePermissionsConfig = Partial<Record<"viewer" | "operator" | "site-engineer" | "site-admin", ScadaPermission[]>>;

const allPermissions = [...SCADA_PERMISSIONS] as ScadaPermission[];
const defaultRolePermissions: Record<"viewer" | "operator" | "site-engineer" | "site-admin", ScadaPermission[]> = {
  viewer: ["dashboard", "live-monitoring", "inverter-details", "electrical-parameters", "energy-analytics", "mppt-strings", "alarms-faults", "historical-data", "scada-reports"],
  operator: ["dashboard", "live-monitoring", "inverter-details", "electrical-parameters", "energy-analytics", "mppt-strings", "alarms-faults", "historical-data", "scada-reports", "data-export", "device-configuration"],
  "site-engineer": ["dashboard", "live-monitoring", "inverter-details", "electrical-parameters", "energy-analytics", "mppt-strings", "alarms-faults", "historical-data", "scada-reports", "data-export", "device-configuration"],
  "site-admin": allPermissions,
};

export function normalizeRole(role: string): "viewer" | "operator" | "site-engineer" | "site-admin" {
  return role === "site-engineer" || role === "operator" || role === "site-admin" ? role : "viewer";
}

export function rolePermissions(role: string, configured?: RolePermissionsConfig): Set<ScadaPermission> {
  const normalized = normalizeRole(role);
  const selected = configured?.[normalized];
  return new Set((selected ?? defaultRolePermissions[normalized]).filter((permission): permission is ScadaPermission => SCADA_PERMISSIONS.includes(permission)));
}

export type ScadaSiteAccess = {
  sites: Set<string>;
  roles: Map<string, "viewer" | "operator" | "site-engineer" | "site-admin">;
  permissions: Map<string, Set<ScadaPermission>>;
  global: boolean;
};

export function resolveSiteAccess(authenticated: boolean, grants: SiteGrant[], globalEnabled: boolean, configured?: RolePermissionsConfig): ScadaSiteAccess {
  if (!authenticated) return { sites: new Set(), roles: new Map(), permissions: new Map(), global: globalEnabled };
  const activeGrants = grants.filter((grant) => grant.status === "active");
  return {
    sites: new Set(activeGrants.map((grant) => grant.siteName)),
    roles: new Map(activeGrants.map((grant) => [grant.siteName, normalizeRole(grant.role)])),
    permissions: new Map(activeGrants.map((grant) => [grant.siteName, rolePermissions(grant.role, configured)])),
    global: activeGrants.length === 0 && globalEnabled,
  };
}

export function canAccessSite(access: ScadaSiteAccess, siteName: string) {
  return access.global || access.sites.has(siteName);
}

export function canAccessSiteRole(access: ScadaSiteAccess, siteName: string, allowed: Array<"viewer" | "operator" | "site-engineer" | "site-admin">) {
  return access.global || allowed.includes(access.roles.get(siteName) ?? "viewer");
}

export function canAccessSitePermission(access: ScadaSiteAccess, siteName: string, permission: ScadaPermission) {
  return access.global || access.permissions.get(siteName)?.has(permission) === true;
}