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