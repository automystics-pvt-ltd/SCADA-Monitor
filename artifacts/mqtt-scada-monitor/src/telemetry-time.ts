/**
 * Shared timestamp parsing for telemetry rows. Every evidence row may carry
 * its capture time as an ISO string, a unix-seconds number, or a
 * unix-milliseconds number -- these two helpers are the single place that
 * normalizes that into an epoch or a display string, so live and saved
 * pipelines never drift on how "when was this observed" is computed.
 */
import type { JsonRecord } from './json-value.ts';

export type TelemetryTimeRow = JsonRecord;

export function telemetryEpoch(row: TelemetryTimeRow): number | null {
  const source = row.date_iso_8601 ?? row.timestamp ?? row.date;
  if (source === undefined || source === null || source === '') return null;
  const numeric = typeof source === 'number' ? source : Number(source);
  const parsed = Number.isFinite(numeric) ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : new Date(String(source));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export type TelemetryDateTime = { date: string; time: string; full: string };

export function telemetryDateTime(row: TelemetryTimeRow): TelemetryDateTime {
  const source = row.date_iso_8601 ?? row.timestamp ?? row.date;
  if (source === undefined || source === null || source === '') return { date: '—', time: '—', full: 'Timestamp unavailable' };
  const numeric = typeof source === 'number' ? source : Number(source);
  const parsed = Number.isFinite(numeric) ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : new Date(String(source));
  if (Number.isNaN(parsed.getTime())) return { date: String(source), time: '—', full: String(source) };
  return {
    date: parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }),
    time: parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
    full: parsed.toLocaleString(),
  };
}
