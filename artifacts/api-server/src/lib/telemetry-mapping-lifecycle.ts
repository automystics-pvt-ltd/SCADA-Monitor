import type { PlatformTelemetryMapping } from "@workspace/db";

type MappingSemantics = Pick<
  PlatformTelemetryMapping,
  | "sourceName"
  | "destination"
  | "displayLabel"
  | "category"
  | "inverterIdentity"
  | "sourceUnit"
  | "displayUnit"
  | "scalingMultiplier"
  | "scalingOffset"
  | "scalingStatus"
  | "status"
>;

function nullableText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A mapping revision represents a semantic change, not a repeat click in the
 * Admin UI. This guard protects audit history, SSE listeners, and cache churn.
 */
export function telemetryMappingIsUnchanged(
  previous: Pick<PlatformTelemetryMapping, keyof MappingSemantics>,
  next: MappingSemantics,
) {
  return previous.sourceName === next.sourceName
    && previous.destination === next.destination
    && previous.displayLabel === next.displayLabel
    && previous.category === next.category
    && nullableText(previous.inverterIdentity) === nullableText(next.inverterIdentity)
    && nullableText(previous.sourceUnit) === nullableText(next.sourceUnit)
    && nullableText(previous.displayUnit) === nullableText(next.displayUnit)
    && previous.scalingMultiplier === next.scalingMultiplier
    && previous.scalingOffset === next.scalingOffset
    && previous.scalingStatus === next.scalingStatus
    && previous.status === next.status;
}