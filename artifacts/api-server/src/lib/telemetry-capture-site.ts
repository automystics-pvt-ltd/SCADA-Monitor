/**
 * Resolves the site used for durable telemetry evidence. An unscoped broker
 * feed can be associated with a managed site only when there is exactly one
 * active managed site; an explicitly declared source site always wins.
 */
export function telemetryCaptureSite(
  explicitSourceSite: string | undefined,
  soleManagedSite: string | undefined,
  configuredSourceSite: string,
) {
  return explicitSourceSite || soleManagedSite || configuredSourceSite;
}

/**
 * Rehomes only legacy evidence that had been recorded under the configured
 * unscoped broker source. This gives the mapping resolver the same stable
 * identity that new managed-site ingestion now produces.
 */
export function managedSourceIdentity(
  managedSite: string,
  sourceName: string,
  normalizedName: string,
  address: string | null,
) {
  return [managedSite, sourceName, normalizedName, address ?? "—"].join("|");
}