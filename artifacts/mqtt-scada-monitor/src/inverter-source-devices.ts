import type { RawInverterSignal } from './telemetry-kpis.ts';
import { discoveryDeviceIdFromSourceRecord } from './device-discovery-identity.ts';
import { inverterInventoryKey } from './inverter-inventory.ts';
import type { JsonRecord } from './json-value.ts';
import { telemetryDateTime, telemetryEpoch, type TelemetryTimeRow } from './telemetry-time.ts';

/**
 * Shared shaping for an inventory signal into a display-ready inverter
 * device. Both the live-preferring dashboard/monitor pipeline and the
 * saved-only Overview pipeline build the same device shape from the same
 * kind of raw evidence rows -- they only disagree on which rows to search
 * and how to classify the resulting reporting state (live vs. saved vs.
 * stale). Keeping that shaping logic here means both call sites move
 * together instead of silently drifting apart.
 */
export type InverterSourceDeviceStatus = 'online' | 'stale';
export type InverterSourceReportingState = 'live' | 'saved' | 'stale';

export type InverterSourceDevice = {
  id: string;
  energyInverterId: string;
  discoveryDeviceId?: string;
  name: string;
  site: string;
  type: 'Power inverter';
  status: InverterSourceDeviceStatus;
  lastSeen: number;
  telemetry: {
    source_tag: {
      parameter: string;
      value: number;
      address: string;
      source_name: string;
      observed_at: string;
      provenance: RawInverterSignal['provenance'];
    };
    raw_modbus_row?: JsonRecord;
  };
  sourceEvidence: RawInverterSignal & {
    sourceName: string;
    observedAt: string;
    reportingState: InverterSourceReportingState;
    semantic: 'inverter-identity' | 'source-reading';
  };
};

function rowSourceName(row: TelemetryTimeRow) {
  return String(row.server_name ?? row.server ?? row.source ?? 'MQTT source');
}

function rowParameter(row: TelemetryTimeRow) {
  return String(row.name ?? row.parameter ?? row.tag ?? '');
}

function rowAddress(row: TelemetryTimeRow) {
  return String(row.full_addr ?? row.address ?? row.addr ?? '—');
}

function rowInverterId(row: TelemetryTimeRow) {
  return String(row.inverter_id ?? row.inverterId ?? '').trim();
}

/**
 * Find the newest evidence row matching an inventory signal's source
 * identity (source name, parameter, address, and inverter id when the
 * signal declares one).
 */
export function findLatestInverterSourceRow(evidenceRows: TelemetryTimeRow[], signal: RawInverterSignal): TelemetryTimeRow | undefined {
  return evidenceRows
    .filter((row) => rowSourceName(row) === signal.sourceName
      && rowParameter(row) === signal.parameter
      && rowAddress(row) === signal.address
      && (!signal.inverterId || rowInverterId(row) === signal.inverterId))
    .sort((left, right) => (telemetryEpoch(right) ?? 0) - (telemetryEpoch(left) ?? 0))[0];
}

export type InverterSourceDeviceContext = {
  site: string;
  now: number;
  /** Classifies the freshness/provenance of the matched source row into a reporting state. */
  reportingState: (info: { signal: RawInverterSignal; sourceRow: TelemetryTimeRow | undefined; rawAgeMs: number }) => InverterSourceReportingState;
};

/**
 * Build a display-ready inverter Device from an inventory signal and the
 * evidence rows it may appear in. `context.reportingState` is the only
 * place live and saved call sites are expected to differ: it decides
 * whether the matched row counts as live, saved, or merely stale.
 */
export function buildInverterSourceDevice(
  signal: RawInverterSignal,
  evidenceRows: TelemetryTimeRow[],
  context: InverterSourceDeviceContext,
): InverterSourceDevice {
  const sourceRow = findLatestInverterSourceRow(evidenceRows, signal);
  const sourceName = signal.sourceName;
  const sourceTime = sourceRow?.date_iso_8601 ?? sourceRow?.timestamp ?? sourceRow?.date ?? signal.observedAt;
  const numericTime = typeof sourceTime === 'number' ? sourceTime : Number(sourceTime);
  const parsedTime = Number.isFinite(numericTime)
    ? new Date(numericTime < 1_000_000_000_000 ? numericTime * 1000 : numericTime).getTime()
    : Date.parse(String(sourceTime ?? ''));
  const observedAt = signal.observedAt ?? (sourceRow ? telemetryDateTime(sourceRow).full : 'Unavailable');
  const rawAgeMs = Number.isFinite(parsedTime) ? context.now - parsedTime : Number.POSITIVE_INFINITY;
  const reportingState = context.reportingState({ signal, sourceRow, rawAgeMs });
  const sourceKey = inverterInventoryKey(signal);
  const discoveryDeviceId = sourceRow ? discoveryDeviceIdFromSourceRecord(sourceRow, sourceName) : undefined;
  return {
    id: `source-${encodeURIComponent(sourceKey)}`,
    energyInverterId: signal.inverterId ?? signal.parameter.toLowerCase(),
    discoveryDeviceId: signal.inverterId ?? discoveryDeviceId,
    name: signal.inverterId ?? signal.parameter.toUpperCase(),
    site: context.site,
    type: 'Power inverter',
    status: reportingState === 'live' ? 'online' : 'stale',
    lastSeen: Number.isFinite(parsedTime) ? parsedTime : context.now,
    telemetry: {
      source_tag: {
        parameter: signal.parameter,
        value: signal.value,
        address: signal.address,
        source_name: sourceName,
        observed_at: observedAt,
        provenance: signal.provenance,
      },
      ...(sourceRow ? { raw_modbus_row: sourceRow } : {}),
    },
    sourceEvidence: {
      ...signal,
      sourceName,
      observedAt,
      reportingState,
      semantic: signal.signalKind === 'identity' ? 'inverter-identity' : 'source-reading',
    },
  };
}
