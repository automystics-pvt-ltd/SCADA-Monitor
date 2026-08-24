export type TelemetryProvenance = "live" | "retained" | "recovered" | "replay";

/**
 * Replayed and recovered events retain raw traceability, but only a payload
 * received directly on the active broker subscription can advance live state.
 */
export function promotesOperationalTelemetry(provenance: TelemetryProvenance) {
  return provenance === "live";
}

function timestampFromRow(row: Record<string, unknown>) {
  const value = row.date_iso_8601 ?? row.timestamp ?? row.date ?? row.serverReceivedAt;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1_000 : value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function provenanceRank(value: unknown) {
  return value === "live" ? 3 : value === "recovered" ? 2 : value === "retained" ? 1 : 0;
}

/**
 * Recovered and replay evidence must never displace a current live row.
 */
export function shouldReplaceTelemetryRow(existing: Record<string, unknown>, incoming: Record<string, unknown>) {
  if (existing.provenance === "live" && incoming.provenance !== "live") return false;
  if (incoming.provenance === "live" && existing.provenance !== "live") return true;
  const existingTimestamp = timestampFromRow(existing);
  const incomingTimestamp = timestampFromRow(incoming);
  if (incomingTimestamp !== existingTimestamp) return incomingTimestamp > existingTimestamp;
  return provenanceRank(incoming.provenance) >= provenanceRank(existing.provenance);
}

function fingerprint(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function telemetryDeliveryIdentity(eventId: string | undefined, topic: string, receivedAt: string | undefined, rawPayload: string) {
  if (eventId && /^\d+$/.test(eventId)) return `event:${eventId}`;
  return `fingerprint:${fingerprint(`${topic}\u0000${receivedAt ?? ""}\u0000${rawPayload}`)}`;
}

export function rememberTelemetryDelivery(seen: Map<string, true>, identity: string, limit = 10_000) {
  if (seen.has(identity)) return false;
  seen.set(identity, true);
  while (seen.size > limit) {
    const first = seen.keys().next().value;
    if (!first) break;
    seen.delete(first);
  }
  return true;
}