import type { PlatformTelemetryDestination } from "@workspace/api-client-react";

/**
 * These destinations identify a physical inverter, so their mapping must
 * carry one managed inverter key for the SCADA fleet consumer.
 */
export function requiresInverterIdentity(destination: PlatformTelemetryDestination) {
  return destination === "inverter-identity" || destination === "active-power";
}

export function inverterIdentityForMapping(destination: PlatformTelemetryDestination, inverterIdentity: string) {
  return requiresInverterIdentity(destination) ? inverterIdentity : null;
}