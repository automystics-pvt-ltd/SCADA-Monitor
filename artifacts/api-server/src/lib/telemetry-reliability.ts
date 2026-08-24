export type DeviceCommunicationState = "live" | "stale" | "interrupted" | "awaiting-first-data";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function telemetryParameterFromRawPayload(rawPayload: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!isRecord(parsed)) return undefined;
    const parameter = isRecord(parsed.Automystics) ? parsed.Automystics : parsed;
    return parameter.name !== undefined || parameter.data !== undefined ? parameter : undefined;
  } catch {
    return undefined;
  }
}

export function sourceTimestampMilliseconds(value: unknown) {
  let candidateMs: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    candidateMs = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      candidateMs = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    } else {
      const parsed = new Date(value).getTime();
      candidateMs = Number.isFinite(parsed) ? parsed : undefined;
    }
  }

  return candidateMs !== undefined && Number.isFinite(new Date(candidateMs).getTime())
    ? candidateMs
    : undefined;
}

export function sourceTimestampIso(value: unknown) {
  const timestampMs = sourceTimestampMilliseconds(value);
  return timestampMs === undefined ? undefined : new Date(timestampMs).toISOString();
}

/**
 * Preserve the last source observation that JavaScript can safely represent.
 * Device clocks are evidence, not a reason to interrupt live delivery: an
 * invalid timestamp stays in the raw payload but cannot poison health status.
 */
export function retainValidSourceTimestamp(previousTimestampMs: number | undefined, parameter: Record<string, unknown> | undefined) {
  if (!parameter) return previousTimestampMs;
  const value = parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date;
  return sourceTimestampMilliseconds(value) ?? previousTimestampMs;
}

export function medianCadenceMs(intervals: number[]) {
  if (!intervals.length) return undefined;
  const sorted = [...intervals].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function heartbeatWindows(cadenceMs: number | undefined) {
  const staleAfterMs = cadenceMs === undefined
    ? 60_000
    : Math.min(120_000, Math.max(30_000, cadenceMs * 3));
  return {
    staleAfterMs,
    interruptedAfterMs: Math.max(180_000, staleAfterMs * 3),
  };
}

export function deviceCommunicationState(lastReceivedAtMs: number | undefined, nowMs: number, cadenceMs: number | undefined) {
  const { staleAfterMs, interruptedAfterMs } = heartbeatWindows(cadenceMs);
  if (lastReceivedAtMs === undefined) {
    return { state: "awaiting-first-data" as const, freshnessAgeMs: undefined, staleAfterMs, interruptedAfterMs };
  }
  const freshnessAgeMs = Math.max(0, nowMs - lastReceivedAtMs);
  const state: DeviceCommunicationState = freshnessAgeMs <= staleAfterMs
    ? "live"
    : freshnessAgeMs <= interruptedAfterMs
      ? "stale"
      : "interrupted";
  return { state, freshnessAgeMs, staleAfterMs, interruptedAfterMs };
}

export function recoveryNeedsResync(requestedAfter: number | undefined, replayHighWater: number | undefined, recoveredSequences: number[]) {
  if (requestedAfter === undefined || replayHighWater === undefined || requestedAfter >= replayHighWater) return false;
  let expectedSequence = requestedAfter + 1;
  for (const sequence of [...recoveredSequences].sort((left, right) => left - right)) {
    if (sequence !== expectedSequence) return true;
    expectedSequence += 1;
  }
  return expectedSequence - 1 !== replayHighWater;
}