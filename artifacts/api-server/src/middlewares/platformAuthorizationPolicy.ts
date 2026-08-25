export type PlatformAdminPrincipalLike = { identityId: string };

export function isPlatformAdmin(principal: PlatformAdminPrincipalLike | undefined): principal is PlatformAdminPrincipalLike {
  return principal !== undefined;
}

export function platformAdminDenial(principal: PlatformAdminPrincipalLike | undefined) {
  return isPlatformAdmin(principal) ? null : {
    status: 401,
    body: { error: "Platform administrator sign-in is required." },
  };
}