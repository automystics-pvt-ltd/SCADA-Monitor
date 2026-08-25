export function safeReturnTo(value: unknown) {
  return typeof value === "string" && value.startsWith("/platform-admin/") && !value.startsWith("//")
    ? value
    : "/platform-admin/";
}

export function adminAllowlist() {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedPlatformAdminEmail(email: unknown) {
  return typeof email === "string" && adminAllowlist().has(email.trim().toLowerCase());
}

export function sessionIdForLogout(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}