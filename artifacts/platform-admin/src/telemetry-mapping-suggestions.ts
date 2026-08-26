import type { PlatformTelemetryDestination, PlatformTelemetryMappingPrecedent } from "@workspace/api-client-react";
import { requiresInverterIdentity } from "./telemetry-mapping-form";
import { heuristicTelemetryDestination, telemetryMappingGuidance } from "./telemetry-mapping-guidance";

export type TelemetryMappingSuggestionConfidence = "precedent" | "heuristic";

export type TelemetryMappingSuggestion = {
  destination: PlatformTelemetryDestination;
  displayLabel: string;
  category: string;
  displayUnit: string | null;
  scalingMultiplier: number;
  scalingOffset: number;
  inverterIdentity: string | null;
  confidence: TelemetryMappingSuggestionConfidence;
  rationale: string;
  precedentSiteName?: string;
  precedentDeviceId?: string;
};

export type SuggestableParameter = {
  siteName: string;
  deviceId: string;
  normalizedName: string;
  address: string | null;
  sourceName: string;
  sourceUnit: string | null;
  originalName: string;
};

/**
 * Plant-level meter/POI readings are explicitly out of scope for automatic
 * inverter-identity inference: they describe the whole site, not one
 * physical inverter, even when they share a device with mapped per-inverter
 * signals. Only a human admin can say whether such a reading should even
 * carry an inverter identity.
 */
const plantLevelMeterPattern = /meter/;

function pickPrecedent(parameter: SuggestableParameter, precedentMappings: PlatformTelemetryMappingPrecedent[]) {
  const candidates = precedentMappings.filter((mapping) => mapping.normalizedName === parameter.normalizedName);
  if (!candidates.length) return null;
  const score = (mapping: PlatformTelemetryMappingPrecedent) => {
    let value = 0;
    if (parameter.address && mapping.address === parameter.address) value += 2;
    if (mapping.sourceName === parameter.sourceName) value += 1;
    return value;
  };
  return [...candidates].sort((a, b) => {
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  })[0];
}

/**
 * Infers a physical inverter identity for a new active-power-destined signal
 * from other signals already mapped on the exact same site+device — e.g. a
 * per-phase power reading on the same "ana" source as an already-mapped
 * active-power/inverter-identity signal reuses that device's established
 * inverter. Only fires when every other mapped signal on this device agrees
 * on a single inverter; any ambiguity, or a plant-level meter name, leaves
 * the field unset for the admin to choose.
 */
function inferDeviceInverterIdentity(parameter: SuggestableParameter, precedentMappings: PlatformTelemetryMappingPrecedent[]): string | null {
  if (plantLevelMeterPattern.test(parameter.normalizedName)) return null;
  const sameDeviceInverterMappings = precedentMappings.filter((mapping) =>
    mapping.siteName === parameter.siteName
    && mapping.deviceId === parameter.deviceId
    && (mapping.destination === "active-power" || mapping.destination === "inverter-identity")
    && mapping.inverterIdentity,
  );
  const distinctIdentities = new Set(sameDeviceInverterMappings.map((mapping) => mapping.inverterIdentity));
  return distinctIdentities.size === 1 ? [...distinctIdentities][0]! : null;
}

/**
 * Suggests a mapping for one unmapped parameter, for admin review only —
 * nothing here is ever saved automatically. Precedent (an identical
 * normalized name already actively mapped elsewhere on the platform) always
 * outranks the name-based heuristic fallback, per the confidence tiers this
 * function reports. Returns `null` when neither approach finds a confident
 * answer, in which case the caller keeps today's plain `discovered-other`
 * default with no suggestion badge.
 */
export function suggestTelemetryMapping(
  parameter: SuggestableParameter,
  precedentMappings: PlatformTelemetryMappingPrecedent[],
): TelemetryMappingSuggestion | null {
  const precedent = pickPrecedent(parameter, precedentMappings);
  if (precedent) {
    const exactAddressMatch = Boolean(parameter.address) && precedent.address === parameter.address;
    const inverterIdentity = requiresInverterIdentity(precedent.destination)
      ? (exactAddressMatch ? precedent.inverterIdentity : null) ?? inferDeviceInverterIdentity(parameter, precedentMappings)
      : null;
    return {
      destination: precedent.destination,
      displayLabel: precedent.displayLabel,
      category: precedent.category,
      displayUnit: parameter.sourceUnit || precedent.displayUnit,
      scalingMultiplier: precedent.scalingMultiplier,
      scalingOffset: precedent.scalingOffset,
      inverterIdentity,
      confidence: "precedent",
      rationale: `Reuses the active mapping already saved for "${precedent.normalizedName}" on ${precedent.siteName} / ${precedent.deviceId}.`,
      precedentSiteName: precedent.siteName,
      precedentDeviceId: precedent.deviceId,
    };
  }

  const guess = heuristicTelemetryDestination(parameter.normalizedName);
  if (!guess) return null;
  const guidance = telemetryMappingGuidance(guess.destination, parameter.originalName || parameter.normalizedName, parameter.sourceUnit);
  return {
    destination: guess.destination,
    displayLabel: guidance.recommendedLabel,
    category: guidance.recommendedCategory,
    displayUnit: parameter.sourceUnit || null,
    scalingMultiplier: 1,
    scalingOffset: 0,
    inverterIdentity: requiresInverterIdentity(guess.destination) ? inferDeviceInverterIdentity(parameter, precedentMappings) : null,
    confidence: "heuristic",
    rationale: `Guessed from the parameter name — no other device on the platform has an active mapping for "${parameter.normalizedName}" yet.`,
  };
}
