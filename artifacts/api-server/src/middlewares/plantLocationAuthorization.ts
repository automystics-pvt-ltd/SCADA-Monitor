import type { AuthUser } from "../lib/auth";

type OperatorSiteAccess = Record<string, string[]>;

function configuredAccess(rawAccess: string | undefined): OperatorSiteAccess {
  if (!rawAccess) return {};
  try {
    const parsed: unknown = JSON.parse(rawAccess);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([identity, sites]) =>
        Array.isArray(sites) && sites.every((site) => typeof site === "string")
          ? [[identity, sites.map((site) => site.trim()).filter(Boolean)]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

/**
 * SCADA_LOCATION_OPERATOR_ACCESS is a JSON object keyed by OIDC subject
 * (`id:<subject>`) or email (`email:<email>`). Each value lists permitted site
 * names; use "*" only for an operator deliberately trusted with every site.
 */
export function canUpdatePlantLocation(
  user: AuthUser | undefined,
  siteName: string,
  rawAccess = process.env.SCADA_LOCATION_OPERATOR_ACCESS,
) {
  if (!user) return false;
  const access = configuredAccess(rawAccess);
  const identities = [
    `id:${user.id}`,
    ...(user.email ? [`email:${user.email.toLowerCase()}`] : []),
  ];
  return identities.some((identity) => {
    const sites = access[identity];
    return sites?.includes("*") || sites?.includes(siteName);
  });
}