import { parseSavedKpiSnapshot, type SavedKpiSnapshot } from "./telemetry-kpis.ts";

const CACHE_PREFIX = "solar-scada-confirmed-snapshot:";

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function confirmedSnapshotCacheKey(siteName: string) {
  return `${CACHE_PREFIX}${encodeURIComponent(siteName.trim())}`;
}

export function readConfirmedSnapshotCache(storage: StorageLike, siteName: string): SavedKpiSnapshot | null {
  try {
    const raw = storage.getItem(confirmedSnapshotCacheKey(siteName));
    if (!raw) return null;
    const snapshot = parseSavedKpiSnapshot(JSON.parse(raw));
    return snapshot?.saveStatus === "saved" ? snapshot : null;
  } catch {
    return null;
  }
}

export function writeConfirmedSnapshotCache(storage: StorageLike, siteName: string, snapshot: SavedKpiSnapshot) {
  if (!siteName.trim() || snapshot.saveStatus !== "saved") return;
  try {
    storage.setItem(confirmedSnapshotCacheKey(siteName), JSON.stringify(snapshot));
  } catch {
    // Storage is an optional display resilience layer; it must never affect
    // backend persistence or cause a saved record to be fabricated.
  }
}

export function clearConfirmedSnapshotCache(storage: StorageLike, siteName: string) {
  try {
    storage.removeItem(confirmedSnapshotCacheKey(siteName));
  } catch {
    // Ignore unavailable browser storage.
  }
}