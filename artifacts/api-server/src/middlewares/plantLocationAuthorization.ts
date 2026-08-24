import type { AuthUser } from "../lib/auth";

function normalizeIdentity(identity: string) {
  const trimmed = identity.trim();
  return trimmed.toLowerCase().startsWith("email:")
    ? `email:${trimmed.slice("email:".length).toLowerCase()}`
    : trimmed;
}

function configuredAdministrators(rawAccess: string | undefined): Set<string> {
  if (!rawAccess) return new Set();
  try {
    const parsed: unknown = JSON.parse(rawAccess);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((identity): identity is string => typeof identity === "string")
        .map(normalizeIdentity)
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * SCADA_LOCATION_ADMIN_ACCESS is a JSON array of OIDC identities:
 * `id:<subject>` or `email:<email>`. Administrators can maintain coordinates
 * for every discovered plant/site. An invalid or missing value fails closed.
 */
export function isPlantLocationAdministrator(
  user: AuthUser | undefined,
  rawAccess = process.env.SCADA_LOCATION_ADMIN_ACCESS,
) {
  if (!user) return false;
  const identities = [
    `id:${user.id}`,
    ...(user.email ? [`email:${user.email.toLowerCase()}`] : []),
  ];
  const administrators = configuredAdministrators(rawAccess);
  return identities.some((identity) => administrators.has(identity));
}

export function canUpdatePlantLocation(
  user: AuthUser | undefined,
  _siteName: string,
  rawAccess = process.env.SCADA_LOCATION_ADMIN_ACCESS,
) {
  return isPlantLocationAdministrator(user, rawAccess);
}