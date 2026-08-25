import { lazy, Suspense, type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';
import { promotesOperationalTelemetry, rememberTelemetryDelivery, shouldReplaceTelemetryRow, telemetryDeliveryIdentity, type TelemetryProvenance } from './telemetry-provenance';
import { approvedDisplayTelemetryUnit, approvedDisplayTelemetryValue, isSourceReportedEvidence, sourceReportedTelemetryUnit, sourceReportedTelemetryValue, transportRawTelemetryValue } from './source-reported-evidence';
import { calculateScadaAggregates, isNewerSavedKpiSnapshot, latestRawCounterMetric, latestRawMetric, parseSavedKpiSnapshot, rawInverterIdentitySignals, rawInverterSignals, selectDashboardSavedEvidence, type PlantCalibrationProfile, type PlantCalibrationSource, type RawInverterSignal, type RawTelemetryMetric, type SavedKpiSnapshot, type ScadaAggregate, type TelemetryKpiRow, type VerifiedKpiCalculation, type VerifiedScadaKpis } from './telemetry-kpis';
import { appendLiveEnergySamples, liveEnergySamplesFromRows, selectLiveEnergySeries, type LiveEnergySample } from './energy-stream';
import { assessSourceBackedInverterFleet, assessValidatedLiveInverterFleet, calculateVerifiedScadaKpis, calibrationPreviewCalculation, selectVerifiedCalculation, type ValidatedInverterFleet, type ValidatedInverterPowerRecord } from './verified-kpis';
import { DashboardPowerFlow } from './components/dashboard-power-flow';
import { collectAlarmFaultEvidence, collectAlarmFaultEvidenceFromRows, getFaultGuidance, telemetryText, type FaultEvidence } from './fault-guidance';
import { dashboardAccessState } from './scada-access';
import { discoveryDeviceIdFromSourceRecord } from './device-discovery-identity';
import { createTelemetryMappingStore, mappedTelemetryDestination, mappedTelemetryDisplayLabel, type ScadaTelemetryMapping } from './telemetry-mappings';
import { clearConfirmedSnapshotCache, readConfirmedSnapshotCache, writeConfirmedSnapshotCache } from './confirmed-snapshot-cache';
import { persistenceNextSaveLabel, persistenceResumeMessage } from './dashboard-persistence';
import {
  Activity, AlertCircle, AlertTriangle, Check, ChevronRight, CloudRain, CloudSun,
  Code2, Copy, Database, Gauge, Layers3, LayoutDashboard,
  Download, Droplets, Grid2X2, LayoutGrid, LocateFixed, MapPin, Menu, PlugZap, Radio, RefreshCw, Search, Settings2,
  Thermometer, Wind, Wifi, WifiOff, X, Zap, Sun, Moon, Bell, FileText, PanelLeftClose, PanelLeftOpen
} from 'lucide-react';
import type * as Recharts from 'recharts';

const queryClient = new QueryClient();
const DEFAULT_BROKER_TOPIC = 'trn246/modbus';

const ChartPlaceholder = ({ children }: { children?: ReactNode }) => <>{children}</>;
type DeviceStatus = 'online' | 'stale' | 'offline';
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type Device = {
  id: string;
  name: string;
  site: string;
  type: string;
  status: DeviceStatus;
  lastSeen: number;
  telemetry: Record<string, JsonValue>;
  energyInverterId?: string;
  discoveryDeviceId?: string;
  sourceEvidence?: {
    parameter: string;
    value: number;
    address: string;
    provenance: TelemetryProvenance;
    inverterId?: string;
    sourceName?: string;
    observedAt?: string;
    unit?: string;
    semantic?: string;
    scalingStatus?: 'validated' | 'raw';
    reportingState?: 'live' | 'stale' | 'saved';
    signalKind?: 'identity';
  };
};
type ModbusRow = Record<string, JsonValue>;
type PersistenceStatus = {
  intervalMinutes: number;
  scheduleStart?: string;
  scheduleEnd?: string;
  timezone?: string;
  inverterEnergySite?: string;
  savingActive?: boolean;
  scheduleState?: 'active' | 'paused';
  currentWindow?: string;
  nextScheduledAt?: string;
  resumeAt?: string;
  pendingMessages: number;
  offlineQueuedSnapshots?: number;
  offlineQueuedMessages?: number;
  lastSnapshotAt?: string;
  lastSnapshotScheduledFor?: string;
  lastSnapshotStatus?: 'saved' | 'missing' | 'incomplete';
  error?: string;
};
type CommunicationHealth = {
  brokerTransport: 'subscribed' | 'connected' | 'disconnected' | 'standby';
  subscriptionState?: 'idle' | 'pending' | 'active' | 'failed';
  deviceCommunication: 'live' | 'stale' | 'interrupted' | 'awaiting-first-data';
  lastReceivedAt?: string;
  lastSourceTimestamp?: string;
  sourceAgeMs?: number;
  dataFrequencySeconds?: number;
  freshnessAgeMs?: number;
  staleAfterMs?: number;
  interruptedAfterMs?: number;
  receivedMessageCount: number;
  lastReceivedSequence?: number;
  confirmedDeliveryGap?: {
    detectedAt: string;
    reason: string;
    startSequence?: number;
    endSequence?: number;
    source: 'sse' | 'persistence';
  };
  activeInterruption?: {
    startedAt: string;
    reason: string;
    lastSequence?: number;
  };
  lastInterruption?: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
    reason: string;
    startSequence?: number;
    endSequence?: number;
  };
  persistenceBacklog?: number;
  persistenceError?: string;
  replayWindow?: { oldestSequence?: number; newestSequence?: number; capacity: number };
};
type StreamPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
type ThemeMode = 'light' | 'dark';
type WeatherLocation = {
  latitude: number;
  longitude: number;
  label: string;
  source: 'Configured plant location';
  updatedAt?: string;
};
type PlantLocation = {
  siteName: string;
  latitude: number;
  longitude: number;
  updatedAt?: string;
};
type CalibrationPreviewResponse = {
  siteName: string;
  checkedAt: string;
  sourceStatus: string;
  mappings: Array<{
    index: number;
    status: 'matched' | 'stale' | 'retained' | 'not-found' | 'invalid';
    reason?: string;
    evidence?: {
      sourceName: string;
      parameter: string;
      address: string;
      rawValue: number;
      observedAt?: string;
      receivedAt: string;
      sequence: number;
      delivery: 'immediate' | 'retained';
    };
  }>;
};
type WeatherData = {
  available: boolean;
  source: string;
  location: {
    latitude: number;
    longitude: number;
    locationName: string | null;
    city: string | null;
    district: string | null;
    state: string | null;
    country: string | null;
    timezone: string | null;
    utcOffsetSeconds: number | null;
    utcOffset: string | null;
    localDateTime: string | null;
    coordinateSource: string;
    reverseGeocodedAt: string | null;
  };
  current: {
    temperatureC: number | null;
    windSpeedMs: number | null;
    windDirectionDeg: number | null;
    humidityPct: number | null;
    irradianceWm2: number | null;
    weatherCondition: string | null;
    cloudCoverPct: number | null;
    precipitationMm: number | null;
  };
  temperatureTrend: Array<{ time: string; temperatureC: number | null }>;
  freshness: {
    observationTime: string | null;
    retrievedAt: string;
    servedAt: string;
    cacheStatus: 'fresh' | 'cached';
  };
};
type WeatherState = {
  status: 'idle' | 'loading' | 'ready' | 'stale' | 'unavailable';
  data?: WeatherData;
  location?: WeatherLocation;
  message?: string;
};

const MODBUS_COLUMNS = [
  'timestamp', 'date', 'date_iso_8601', 'bdate', 'server_id', 'bserver_id',
  'addr', 'baddr', 'full_addr', 'size', 'data', 'raw_data', 'reported_value', 'reported_unit', 'source_identity', 'server_name', 'ip', 'name',
] as const;

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findWeatherLocation(siteName: string, siteLocations: Record<string, PlantLocation>): WeatherLocation | null {
  const configuredLocation = siteLocations[siteName];
  if (configuredLocation && Number.isFinite(configuredLocation.latitude) && configuredLocation.latitude >= -90 && configuredLocation.latitude <= 90 && Number.isFinite(configuredLocation.longitude) && configuredLocation.longitude >= -180 && configuredLocation.longitude <= 180) {
    return {
      latitude: configuredLocation.latitude,
      longitude: configuredLocation.longitude,
      label: `${siteName} · configured plant location`,
      source: 'Configured plant location',
      updatedAt: configuredLocation.updatedAt,
    };
  }

  return null;
}

function extractModbusRows(payload: JsonValue): ModbusRow[] {
  const rows: ModbusRow[] = [];
  const visited = new Set<unknown>();
  const appendRow = (candidate: Record<string, JsonValue>) => {
    const name = candidate.name ?? candidate.parameter ?? candidate.tag ?? candidate.registerName ?? candidate.originalName;
    const data = candidate.data ?? candidate.raw_data ?? candidate.rawValue ?? candidate.raw_value ?? candidate.value ?? candidate.currentValue ?? candidate.current_value;
    if (name === undefined || data === undefined) return;
    const discoveredReportedValue = candidate.reportedNumericValue ?? (
      candidate.rawValue !== undefined && candidate.value !== undefined ? candidate.value : undefined
    );
    rows.push({
      ...candidate,
      name: String(name),
      data,
      raw_data: candidate.raw_data ?? candidate.rawValue ?? candidate.raw_value ?? data,
      ...(candidate.reported_value !== undefined || candidate.reportedValue !== undefined || candidate.customer_value !== undefined || candidate.customerValue !== undefined || candidate.engineering_value !== undefined || candidate.engineeringValue !== undefined || discoveredReportedValue !== undefined
        ? { reported_value: candidate.reported_value ?? candidate.reportedValue ?? candidate.customer_value ?? candidate.customerValue ?? candidate.engineering_value ?? candidate.engineeringValue ?? discoveredReportedValue }
        : {}),
      reported_unit: candidate.reported_unit ?? candidate.reportedUnit ?? candidate.customer_unit ?? candidate.customerUnit ?? candidate.source_unit ?? candidate.sourceUnit ?? candidate.engineering_unit ?? candidate.engineeringUnit,
      source_unit: candidate.source_unit ?? candidate.sourceUnit,
      source_mapping_status: candidate.source_mapping_status ?? candidate.sourceMappingStatus,
      source_identity: candidate.source_identity ?? candidate.sourceIdentity,
      full_addr: candidate.full_addr ?? candidate.address ?? candidate.register ?? candidate.addr,
      server_name: candidate.server_name ?? candidate.source ?? candidate.sourceName ?? candidate.device ?? candidate.server,
    });
  };
  const pending: JsonValue[] = [payload];
  let nodes = 0;
  while (pending.length && nodes < 10_000) {
    const value = pending.pop()!;
    nodes += 1;
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    appendRow(value);
    pending.push(...Object.values(value));
  }
  return rows;
}

function sourceReportedValue(row: ModbusRow) {
  return (approvedDisplayTelemetryValue(row) ?? sourceReportedTelemetryValue(row)) as JsonValue | undefined;
}

function sourceTransportValue(row: ModbusRow) {
  return transportRawTelemetryValue(row) as JsonValue | undefined;
}

function hasSourceReportedValue(row: ModbusRow) {
  return isSourceReportedEvidence(row);
}

function modbusRowKey(row: ModbusRow) {
  return `${String(row.server_name ?? '')}|${String(row.name ?? '')}|${String(row.addr ?? '')}`;
}

function telemetryDisplayLabel(row: ModbusRow) {
  return mappedTelemetryDisplayLabel(row);
}

function telemetrySourceParameter(row: ModbusRow) {
  return String(row.name ?? row.parameter ?? row.tag ?? row.normalizedName ?? "—");
}

function isMappedAlarmOrFault(row: ModbusRow) {
  return ["alarm", "fault"].includes(String(mappedTelemetryDestination(row) ?? "").toLowerCase());
}

function extractDevices(payload: JsonValue): Record<string, JsonValue>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (payload.id || payload.device || payload.name) return [payload];

  const embeddedDevices = Object.entries(payload).reduce<Record<string, JsonValue>[]>(
    (devices, [key, value]) => isRecord(value) ? [...devices, { id: key, ...value }] : devices,
    [],
  );

  return embeddedDevices.length ? embeddedDevices : [payload];
}

function numberFrom(device: Device, path: string[], fallback = 0) {
  let value: JsonValue = device.telemetry;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
    value = value[segment];
  }
  return typeof value === 'number' ? value : fallback;
}

const DEVICE_ONLINE_MAX_AGE_MS = 30_000;
const DEVICE_STALE_MAX_AGE_MS = 120_000;
function statusAt(device: Device, now: number, mode: 'demo' | 'live'): DeviceStatus {
  if (mode === 'demo') return device.status;
  const age = now - device.lastSeen;
  if (age <= DEVICE_ONLINE_MAX_AGE_MS) return 'online';
  if (age <= DEVICE_STALE_MAX_AGE_MS) return 'stale';
  return 'offline';
}

function sourceBackedInverterDevice(record: ValidatedInverterPowerRecord, site: string): Device {
  const observedAt = Date.parse(record.sourceTimestamp);
  return {
    id: `validated-inverter-${encodeURIComponent(record.inverterId)}`,
    energyInverterId: record.inverterId,
    discoveryDeviceId: record.inverterId,
    name: record.inverterName,
    site,
    type: 'Power inverter',
    status: 'online',
    lastSeen: Number.isFinite(observedAt) ? observedAt : Date.now(),
    telemetry: {
      power: { active_kw: record.value },
      source_record: {
        inverter_id: record.inverterId,
        parameter: record.parameter,
        source_name: record.sourceName,
        source_timestamp: record.sourceTimestamp,
        semantic: record.semantic,
        unit: record.unit,
        scaling_status: record.scalingStatus,
      },
    },
    sourceEvidence: {
        inverterId: record.inverterId,
      parameter: record.parameter,
      value: record.value,
      address: record.address,
      provenance: record.provenance,
      sourceName: record.sourceName,
      observedAt: record.sourceTimestamp,
      unit: record.unit,
      semantic: record.semantic,
      scalingStatus: record.scalingStatus,
    },
  };
}

function apiValidatedInverterRecord(value: unknown): ValidatedInverterPowerRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inverterId = typeof record.inverterId === 'string' ? record.inverterId.trim() : '';
  const inverterName = typeof record.inverterName === 'string' ? record.inverterName.trim() : '';
  const parameter = typeof record.parameter === 'string' ? record.parameter : '';
  const power = typeof record.value === 'number' ? record.value : Number(record.value);
  const sourceName = typeof record.sourceName === 'string' ? record.sourceName : '';
  const address = typeof record.address === 'string' ? record.address : '';
  const sourceTimestamp = typeof record.observedAt === 'string' ? record.observedAt : '';
  if (!inverterId || !inverterName || !parameter || !Number.isFinite(power) || !sourceName || !address || !sourceTimestamp) return undefined;
  if (record.unit !== 'kW' || record.activePowerSemantic !== 'active-power' || record.scalingStatus !== 'validated') return undefined;
  return {
    inverterId,
    inverterName,
    parameter,
    value: power,
    rawValue: typeof record.rawValue === 'string' ? record.rawValue : String(power),
    unit: 'kW',
    semantic: 'active-power',
    scalingStatus: 'validated',
    sourceName,
    address,
    sourceTimestamp,
    provenance: 'live',
  };
}
function formatValue(value: JsonValue) {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatInPlantTimezone(value: string | undefined, timezone: string | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatCurrentTimeInTimezone(now: number, timezone: string | null | undefined) {
  if (!timezone) return 'Location data unavailable';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'medium',
      hourCycle: 'h23',
    }).format(new Date(now));
  } catch {
    return 'Location data unavailable';
  }
}

function formatElapsed(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1_000) return '<1s';
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor(ms % 60_000 / 1_000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor(ms % 3_600_000 / 60_000)}m`;
}

function formatCountdown(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function communicationLabel(state: CommunicationHealth['deviceCommunication'] | undefined) {
  switch (state) {
    case 'live': return 'Live';
    case 'stale': return 'Stale';
    case 'interrupted': return 'Interrupted';
    default: return 'Awaiting first data';
  }
}

function communicationTone(state: CommunicationHealth['deviceCommunication'] | undefined): 'success' | 'warning' | 'destructive' | 'neutral' {
  if (state === 'live') return 'success';
  if (state === 'stale') return 'warning';
  if (state === 'interrupted') return 'destructive';
  return 'neutral';
}

function flattenJson(value: JsonValue, path = ''): Array<{ path: string; value: string; type: string }> {
  if (!isRecord(value) && !Array.isArray(value)) {
    return [{ path: path || 'payload', value: formatValue(value), type: value === null ? 'null' : typeof value }];
  }
  if (Array.isArray(value)) {
    if (!value.length) return [{ path: path || 'payload', value: '[]', type: 'array' }];
    return value.flatMap((item, index) => flattenJson(item, `${path}[${index}]`));
  }
  const entries = Object.entries(value);
  if (!entries.length) return [{ path: path || 'payload', value: '{}', type: 'object' }];
  return entries.flatMap(([key, child]) => flattenJson(child, path ? `${path}.${key}` : key));
}

type TelemetrySortKey = 'category' | 'parameter' | 'raw' | 'scaled' | 'unit' | 'address' | 'date' | 'time' | 'source';
type SortDirection = 'asc' | 'desc';

function telemetryCategory(row: ModbusRow) {
  const mappedCategory = row.admin_mapping_category ?? row.adminMappingCategory;
  if (typeof mappedCategory === 'string' && mappedCategory.trim()) return mappedCategory.trim();
  const mappedDestination = String(row.admin_mapping_destination ?? row.adminMappingDestination ?? '').toLowerCase();
  if (['active-power', 'voltage', 'current', 'frequency'].includes(mappedDestination)) return 'Electrical';
  if (['daily-energy', 'total-energy', 'specific-yield'].includes(mappedDestination)) return 'Energy';
  if (['alarm', 'fault'].includes(mappedDestination)) return 'Alarms';
  if (mappedDestination === 'communication') return 'Communication';
  if (mappedDestination === 'environmental') return 'Environment';
  const name = String(row.name || '').toLowerCase();
  if (name.includes('voltage') || name.includes('current')) return 'Electrical';
  if (name.includes('power') || name.includes('frequency')) return 'Power';
  if (name.includes('temp') || name.includes('irradiance')) return 'Environment';
  if (name.includes('alarm') || name.includes('fault')) return 'Alarms';
  return 'Device';
}

function telemetryUnit(row: ModbusRow) {
  const sourceUnit = approvedDisplayTelemetryUnit(row) ?? sourceReportedTelemetryUnit(row) ?? row.reported_unit ?? row.reportedUnit ?? row.customer_unit ?? row.customerUnit ?? row.source_unit ?? row.sourceUnit ?? row.engineering_unit ?? row.engineeringUnit ?? row.unit ?? row.units;
  return typeof sourceUnit === 'string' && sourceUnit.trim() ? sourceUnit.trim() : 'Raw / not declared';
}

function telemetryDateTime(row: ModbusRow) {
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

type AlarmFaultReport = {
  device?: Device;
  kind: 'Alarm' | 'Fault';
  fault: FaultEvidence;
};

function uniqueAlarmFaultReports(reports: AlarmFaultReport[]) {
  return Array.from(new Map(reports.map((report) => [
    `${report.kind}|${report.fault.code ?? ''}|${report.fault.title}|${report.fault.source}|${report.fault.observedAt ?? ''}|${report.fault.rawValue}`,
    report,
  ])).values());
}

function deviceAlarmFaultReports(devices: Device[]): AlarmFaultReport[] {
  return uniqueAlarmFaultReports(devices.flatMap((device) => {
    const evidence = collectAlarmFaultEvidence(device.telemetry);
    return [
      ...evidence.alarms.map((fault) => ({ device, kind: 'Alarm' as const, fault })),
      ...evidence.faults.map((fault) => ({ device, kind: 'Fault' as const, fault })),
    ];
  }));
}

function rowAlarmFaultReports(rows: ModbusRow[]): AlarmFaultReport[] {
  const evidence = collectAlarmFaultEvidenceFromRows(rows);
  return [
    ...evidence.alarms.map((fault) => ({ kind: 'Alarm' as const, fault })),
    ...evidence.faults.map((fault) => ({ kind: 'Fault' as const, fault })),
  ];
}

function hasExplicitAlarmFaultField(device: Device) {
  return ['alarms', 'alarm', 'alarmCode', 'alarm_code', 'alarmStatus', 'alarm_status', 'warnings', 'warning', 'faults', 'fault', 'faultCode', 'fault_code', 'faultStatus', 'fault_status', 'errors', 'error', 'errorCode', 'error_code']
    .some((key) => Object.prototype.hasOwnProperty.call(device.telemetry, key));
}

function exportBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeXml(value: unknown) {
  return String(value ?? '').replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] || character));
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character] || character));
}

function CustomBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'destructive' }) {
  const tones = {
    neutral: 'bg-slate-800 text-slate-300 border-slate-700',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    destructive: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}

const energyData = [
  { name: 'Mon', value: 12.5 },
  { name: 'Tue', value: 14.2 },
  { name: 'Wed', value: 13.8 },
  { name: 'Thu', value: 15.1 },
  { name: 'Fri', value: 14.8 },
  { name: 'Sat', value: 11.2 },
  { name: 'Sun', value: 14.13 },
];

const demoPowerTrendData = Array.from({ length: 24 }).map((_, i) => {
  let val = 0;
  if (i > 6 && i < 19) {
    val = Math.sin((i - 6) / 12 * Math.PI) * 20156;
  }
  return { time: `${i}:00`, power: Number((val + (val > 0 ? ((i * 137) % 500) : 0)).toFixed(1)) };
});

const COLORS = ['#00E5FF', '#00F2A6', '#FF5C00', '#F50057', '#7C4DFF', '#3D5AFE', '#FFEA00'];
const CHART_TOOLTIP_STYLE = { backgroundColor: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: '12px', fontSize: '12px', backdropFilter: 'blur(12px)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' };
const CHART_ITEM_STYLE = { color: 'var(--scada-text)', fontWeight: 600, fontFamily: 'var(--app-font-mono)' };
const energyDataByRange = {
  daily: energyData,
  monthly: energyData.map((entry, index) => ({ name: `W${index + 1}`, value: Number((entry.value * 6.8).toFixed(1)) })),
  yearly: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((name, index) => ({ name, value: 280 + Math.round(Math.sin(index / 12 * Math.PI) * 185) })),
};
const powerTrendByRange = {
  today: demoPowerTrendData,
  week: demoPowerTrendData.map((entry, index) => ({ time: `D${index + 1}`, power: Math.max(0, Number((entry.power * (0.84 + (index % 5) * 0.04)).toFixed(1))) })),
  month: demoPowerTrendData.map((entry, index) => ({ time: `W${index + 1}`, power: Math.max(0, Number((entry.power * (0.78 + (index % 7) * 0.035)).toFixed(1))) })),
};


function Sidebar({ onSettings, mobileOpen, onClose, activeSection, onNavigate, collapsed, onToggleCollapse }: {
  onSettings: () => void;
  mobileOpen: boolean;
  onClose: () => void;
  activeSection: string;
  onNavigate: (section: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const navigationRef = useModalAccessibility(onClose, mobileOpen);
  const navigate = (section: string) => {
    onNavigate(section);
    onClose();
  };

  return (
    <aside ref={navigationRef} id="primary-navigation" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? true : undefined} aria-label="Primary navigation" tabIndex={mobileOpen ? -1 : undefined} className={`scada-sidebar scada-app-sidebar fixed inset-y-0 left-0 z-30 flex h-[100dvh] min-h-0 w-[min(86vw,260px)] shrink-0 flex-col overflow-hidden border-r border-[#1E293B] bg-[#050811] transition-[width,transform] duration-300 md:sticky md:top-0 md:h-dvh md:translate-x-0 ${collapsed ? 'md:w-[76px]' : 'md:w-[200px] lg:w-[230px] xl:w-[260px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} shadow-[4px_0_24px_rgba(0,0,0,0.4)]`}>
      <div className={`flex h-[72px] shrink-0 items-center border-b border-[#1E293B] px-4 bg-[#090B13] ${collapsed ? 'md:justify-center md:gap-2' : 'gap-3 md:px-5'}`}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#2563EB]/20 text-[#2563EB] border border-[#2563EB]/30 shadow-[0_0_10px_rgba(37,99,235,0.2)]">
            <Sun size={20} strokeWidth={2.5} />
          </div>
          <div className={`min-w-0 ${collapsed ? 'md:hidden' : ''}`}>
            <h1 className="truncate text-[13px] font-bold tracking-wide text-slate-100 uppercase">Solar SCADA</h1>
            <p className="truncate text-[9px] text-[#2563EB] font-bold uppercase tracking-widest mt-0.5">Northline Plant</p>
          </div>
        </div>
        <button type="button" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} data-testid="button-toggle-navigation" title={collapsed ? 'Expand navigation' : 'Collapse navigation'} onClick={onToggleCollapse} className={`ml-auto hidden rounded-lg p-2 text-slate-500 hover:bg-[#1E293B] hover:text-slate-200 focus-ring md:flex transition-colors ${collapsed ? 'md:ml-0' : ''}`}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
        <button type="button" aria-label="Close navigation" data-testid="button-close-navigation" title="Close navigation" onClick={onClose} className="ml-auto rounded-lg p-2 text-slate-500 hover:bg-[#1E293B] hover:text-slate-200 focus-ring md:hidden transition-colors">
          <X size={18} />
        </button>
      </div>
      
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-6 scrollbar-thin">
        <div className="mb-8">
          <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 ${collapsed ? 'md:hidden' : ''}`}>Overview</p>
          <nav className="space-y-1.5">
            <NavItem icon={LayoutDashboard} label="Dashboard" active={activeSection === 'overview'} onClick={() => navigate('overview')} collapsed={collapsed} />
            <NavItem icon={Layers3} label="Plant Overview" active={activeSection === 'overview'} onClick={() => navigate('overview')} collapsed={collapsed} />
          </nav>
        </div>
        
        <div className="mb-8">
          <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 ${collapsed ? 'md:hidden' : ''}`}>Monitoring</p>
          <nav className="space-y-1.5">
            <NavItem icon={Zap} label="Inverters" active={activeSection === 'inverters'} hasArrow onClick={() => navigate('inverters')} collapsed={collapsed} />
            <NavItem icon={Activity} label="Live Data" active={activeSection === 'live-data'} onClick={() => navigate('live-data')} collapsed={collapsed} />
            <NavItem icon={Gauge} label="Energy Analytics" active={activeSection === 'energy'} onClick={() => navigate('energy')} collapsed={collapsed} />
            <NavItem icon={CloudSun} label="Environment" active={activeSection === 'environment'} onClick={() => navigate('environment')} collapsed={collapsed} />
            <NavItem icon={AlertTriangle} label="Alarms & Events" active={activeSection === 'alarms'} onClick={() => navigate('alarms')} collapsed={collapsed} />
          </nav>
        </div>

        <div>
          <p className={`px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 ${collapsed ? 'md:hidden' : ''}`}>Insights</p>
          <nav className="space-y-1.5">
            <NavItem icon={FileText} label="Reports" active={activeSection === 'raw-data'} onClick={() => navigate('raw-data')} collapsed={collapsed} />
            <NavItem icon={Activity} label="Performance" active={activeSection === 'power'} onClick={() => navigate('power')} collapsed={collapsed} />
            <NavItem icon={Settings2} label="Settings" onClick={() => { onSettings(); onClose(); }} collapsed={collapsed} />
          </nav>
        </div>
      </div>
       <div aria-hidden="true" className={`scada-sidebar-accent relative h-28 shrink-0 overflow-hidden border-t border-[#1E293B] transition-[height,opacity] duration-300 ${collapsed ? 'md:h-0 md:border-t-0 md:opacity-0' : ''}`}>
         <img src="/assets/solar-array-accent.webp" alt="" loading="lazy" decoding="async" fetchPriority="low" className="scada-sidebar-accent-image absolute inset-0 h-full w-full object-cover object-[center_68%]" />
         <div className="scada-sidebar-accent-wash absolute inset-0" />
         <div className="relative z-10 flex h-full flex-col justify-end px-5 pb-4">
           <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">Solar plant network</p>
           <p className="mt-1 text-xs font-semibold text-slate-200">Northline operations</p>
         </div>
       </div>
         <div className={`scada-sidebar-powered shrink-0 border-t border-[#1E293B] px-4 py-3 text-[9px] leading-4 transition-[opacity,height,padding] duration-300 ${collapsed ? 'md:h-0 md:overflow-hidden md:border-t-0 md:px-0 md:py-0 md:opacity-0' : ''}`}>
           <span className="scada-powered-label">Powered by</span>
           <span className="scada-powered-brand">Automystics Technologies <strong>Pvt Ltd.</strong></span>
        </div>
    </aside>
  );
}

function NavItem({ icon: Icon, label, active, hasArrow, onClick, collapsed }: any) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} title={`Open ${label}`} className={`scada-nav-item ${collapsed ? 'scada-nav-item--collapsed' : ''} w-full rounded-lg px-3 py-2.5 text-[13px] transition-all focus-ring font-medium tracking-wide ${active ? 'bg-[#2563EB]/10 text-[#2563EB] shadow-[inset_3px_0_0_#2563EB]' : 'text-slate-400 hover:text-slate-200 hover:bg-[#1E293B]/50'}`}>
      <span className="scada-nav-content">
        <span className="scada-nav-icon-wrap">
          <Icon size={18} className={`scada-nav-icon ${active ? 'text-[#2563EB]' : ''}`} />
        </span>
        <span className="scada-nav-label">{label}</span>
      </span>
      <span className={`scada-nav-arrow-slot ${collapsed ? 'md:hidden' : ''}`}>
        {hasArrow && <ChevronRight size={14} className="scada-nav-arrow text-slate-500" />}
      </span>
      <span aria-hidden="true" className={`scada-nav-status-dot ${active ? 'scada-nav-status-dot--active' : ''}`} />
    </button>
  );
}

type ScrollLockSnapshot = {
  bodyOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyWidth: string;
  htmlOverflow: string;
  scrollY: number;
};

let activeScrollLocks = 0;
let scrollLockSnapshot: ScrollLockSnapshot | null = null;

function lockDocumentScroll() {
  if (activeScrollLocks === 0) {
    scrollLockSnapshot = {
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
      bodyTop: document.body.style.top,
      bodyWidth: document.body.style.width,
      htmlOverflow: document.documentElement.style.overflow,
      scrollY: window.scrollY,
    };
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollLockSnapshot.scrollY}px`;
    document.body.style.width = '100%';
  }
  activeScrollLocks += 1;
}

function unlockDocumentScroll() {
  activeScrollLocks = Math.max(0, activeScrollLocks - 1);
  if (activeScrollLocks !== 0 || !scrollLockSnapshot) return;

  const snapshot = scrollLockSnapshot;
  document.documentElement.style.overflow = snapshot.htmlOverflow;
  document.body.style.overflow = snapshot.bodyOverflow;
  document.body.style.position = snapshot.bodyPosition;
  document.body.style.top = snapshot.bodyTop;
  document.body.style.width = snapshot.bodyWidth;
  window.scrollTo(0, snapshot.scrollY);
  scrollLockSnapshot = null;
}

function useModalAccessibility(onClose: () => void, enabled = true) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const getFocusable = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>(selector))
      .filter((element) => element.getClientRects().length > 0);
    const focusFirst = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      (getFocusable(dialog)[0] ?? dialog).focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = getFocusable(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    lockDocumentScroll();
    window.addEventListener('keydown', trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', trapFocus);
      unlockDocumentScroll();
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [enabled]);

  return dialogRef;
}

function Header({ toggleMobileNav, mobileNav, connected, connectionLabel, mode, theme, onToggleTheme, onRefresh, onExport, onNotifications, onSettings, now, weather, siteName }: {
  toggleMobileNav: () => void;
  mobileNav: boolean;
  connected: boolean;
  connectionLabel: string;
  mode: 'demo' | 'live';
  theme: ThemeMode;
  onToggleTheme: () => void;
  onRefresh: () => void;
  onExport: () => void;
  onNotifications: () => void;
  onSettings: () => void;
  now: number;
  weather: WeatherState;
  siteName: string;
}) {
  const temperature = weather.data?.current.temperatureC;
  const condition = weather.data?.current.weatherCondition;
  const irradiance = weather.data?.current.irradianceWm2;
  const weatherUpdated = weather.data?.freshness.retrievedAt ? new Date(weather.data.freshness.retrievedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
  const weatherLocationLabel = weather.data?.location.locationName ?? (weather.location ? 'Resolving configured coordinates…' : 'Location data unavailable');
  const weatherProvenance = weather.data ? `${weather.data.source} · ${weatherLocationLabel}` : 'Source unavailable';
  const weatherCoordinates = weather.data?.location ?? weather.location;
  const weatherCoordinateLabel = weatherCoordinates
    ? `${weatherCoordinates.latitude.toFixed(5)}°, ${weatherCoordinates.longitude.toFixed(5)}°`
    : 'Coordinates not configured';
  const observationTime = weather.data?.freshness.observationTime?.replace('T', ' ') ?? 'Data unavailable';
  const receivedTime = weatherUpdated ?? 'Data unavailable';
  const weatherCacheStatus = weather.data?.freshness.cacheStatus === 'fresh' ? 'Fresh response' : weather.data?.freshness.cacheStatus === 'cached' ? 'Cached ≤ 4 min' : 'Data unavailable';
  const weatherLocalTime = weather.data?.location.localDateTime ?? 'Location data unavailable';
  const weatherMetadata = weather.data ? `${weatherProvenance} · Local ${weatherLocalTime} · Observed ${observationTime} · Received ${receivedTime} · ${weatherCacheStatus}` : 'Weather data unavailable';
  return (
    <header className="scada-app-header flex min-h-[72px] flex-wrap shrink-0 items-center justify-between gap-3 border-b border-[#1E293B] bg-[#090B13] px-4 py-3 sm:px-6 2xl:flex-nowrap shadow-sm relative z-20">
      <div className="flex min-w-0 flex-1 items-center gap-3 md:gap-5">
        <button type="button" aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={mobileNav} data-testid="button-open-navigation" title="Open navigation" className="md:hidden shrink-0 text-slate-400 rounded-lg p-2 hover:bg-[#1E293B] focus-ring transition-colors" onClick={toggleMobileNav}>
          <Menu size={20} />
        </button>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            <h2 className="truncate text-[15px] font-bold tracking-wider text-slate-100 uppercase">TRN246 Solar Plant</h2>
            <div className="shrink-0">
             <CustomBadge tone={connectionLabel === 'LIVE' || connectionLabel === 'DEMO' ? 'success' : 'warning'}><span className={`w-1.5 h-1.5 rounded-full shadow-[0_0_8px_currentColor] ${connectionLabel === 'LIVE' || connectionLabel === 'DEMO' ? 'bg-[#00F2A6] pulse-soft' : 'bg-[#FFEA00]'}`} />{connectionLabel}</CustomBadge>
            </div>
          </div>
          <p className="mt-1 truncate text-[11px] font-bold text-slate-500 uppercase tracking-widest mono">Utility-scale PV • {new Date(now).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 2xl:hidden">
        <button type="button" aria-label="Open settings" data-testid="button-open-settings-header" title="Open settings" onClick={onSettings} className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#1E293B] text-slate-400 bg-[#0F1322] hover:bg-[#1E293B] hover:text-slate-100 focus-ring transition-all"><Settings2 size={16} /></button>
        <button type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} data-testid="button-toggle-theme" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={onToggleTheme} className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#1E293B] text-slate-400 bg-[#0F1322] hover:bg-[#1E293B] hover:text-slate-100 focus-ring transition-all">{theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</button>
        <button type="button" aria-label="Open alarms and notifications" data-testid="button-notifications-compact" title="Open alarms and notifications" onClick={onNotifications} className="relative hidden h-10 w-10 items-center justify-center rounded-lg border border-[#1E293B] text-slate-400 bg-[#0F1322] hover:bg-[#1E293B] hover:text-slate-100 focus-ring transition-all md:flex"><Bell size={16} /><span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[#F50057] shadow-[0_0_8px_#F50057]" /></button>
        <button type="button" aria-label="Refresh telemetry" data-testid="button-refresh-telemetry-mobile" title="Refresh telemetry" onClick={onRefresh} className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#1E293B] text-slate-400 bg-[#0F1322] hover:bg-[#1E293B] hover:text-slate-100 focus-ring transition-all"><RefreshCw size={16} /></button>
        <button type="button" aria-label="Export live telemetry as CSV" data-testid="button-export-telemetry-compact" title="Export live telemetry as CSV" onClick={onExport} className="hidden h-10 w-10 items-center justify-center rounded-lg border border-[#1E293B] text-slate-400 bg-[#0F1322] hover:bg-[#1E293B] hover:text-slate-100 focus-ring transition-all md:flex"><Download size={16} /></button>
      </div>
      <div className="order-3 flex w-full min-w-0 flex-wrap items-center gap-2 border-t border-[#1E293B]/70 pt-3 2xl:hidden" aria-label="Plant status summary">
        <span className="scada-status-chip flex shrink-0 items-center gap-2 rounded-lg border border-[#1E293B] bg-[#0F1322] px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase text-slate-300"><CloudSun size={12} className="text-slate-400" />{temperature === null || temperature === undefined || !condition ? 'Weather unavailable' : `${temperature.toFixed(1)}°C ${condition}`}</span>
        <span className="scada-status-chip flex shrink-0 items-center gap-2 rounded-lg border border-[#1E293B] bg-[#0F1322] px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase text-slate-300"><Zap size={12} className="text-slate-400" />{irradiance === null || irradiance === undefined ? 'Irradiance not reported' : `${irradiance.toFixed(0)} W/m²`}</span>
        <span className="scada-status-chip flex shrink-0 items-center gap-2 rounded-lg border border-[#1E293B] bg-[#0F1322] px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase text-slate-300"><MapPin size={12} className="text-slate-400" />{weatherProvenance}</span>
      </div>
      
      <div className="hidden min-w-0 flex-1 items-center justify-end gap-3 pl-4 2xl:flex">
        <div className="scada-status-chip flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0F1322] border border-[#1E293B] text-[10px] font-bold tracking-widest uppercase text-slate-300">
          <CloudSun size={13} className="text-[#00E5FF]" />
          <span>{temperature === null || temperature === undefined || !condition ? 'Weather unavailable' : `${temperature.toFixed(1)}°C ${condition}`}</span>
        </div>
        <div className="scada-status-chip flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0F1322] border border-[#1E293B] text-[10px] font-bold tracking-widest uppercase text-slate-300">
          <Zap size={13} className="text-[#FF5C00]" />
          <span>{irradiance === null || irradiance === undefined ? 'Irradiance not reported' : `${irradiance.toFixed(0)} W/m²`}</span>
        </div>
        <div className="scada-status-chip flex max-w-[180px] items-center gap-2 truncate px-3 py-1.5 rounded-lg bg-[#0F1322] border border-[#1E293B] text-[10px] font-bold tracking-widest uppercase text-slate-300 xl:max-w-[240px]" title={weatherProvenance} aria-label={`Weather source and location: ${weatherProvenance}`}>
          <MapPin size={13} className="shrink-0 text-slate-400" />
          <span className="truncate">{weatherProvenance}</span>
        </div>
        <div className="scada-status-chip flex max-w-[210px] items-center gap-2 truncate px-3 py-1.5 rounded-lg bg-[#0F1322] border border-[#1E293B] text-[10px] font-bold tracking-widest uppercase text-slate-300" title={weatherMetadata} aria-label={`Weather timing and cache status: ${weatherMetadata}`}>
          <RefreshCw size={13} className="text-slate-400" />
           <span className="truncate">{weather.data ? `Obs ${observationTime} · Rec ${receivedTime}` : 'Weather data unavailable'}</span>
        </div>
        <div className="scada-status-chip flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0F1322] border border-[#1E293B] text-[10px] font-bold tracking-widest uppercase text-slate-300">
          <Activity size={13} className="text-[#00F2A6]" />
           <span>{mode === 'live' ? 'SSE stream' : 'Demo stream'}</span>
        </div>
        
        <div className="flex items-center gap-2 border-l border-[#1E293B] pl-5 ml-2">
          <button type="button" aria-label="Open settings" data-testid="button-open-settings-header-wide" title="Open settings" onClick={onSettings} className="w-10 h-10 flex items-center justify-center rounded-lg border border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#1E293B] hover:border-[#1E293B]/50 transition-all focus-ring"><Settings2 size={16} /></button>
          <button type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} data-testid="button-toggle-theme-wide" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={onToggleTheme} className="w-10 h-10 flex items-center justify-center rounded-lg border border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#1E293B] hover:border-[#1E293B]/50 transition-all focus-ring">{theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</button>
          <button type="button" aria-label="Open alarms and notifications" data-testid="button-notifications" title="Open alarms and notifications" onClick={onNotifications} className="w-10 h-10 flex items-center justify-center rounded-lg border border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#1E293B] hover:border-[#1E293B]/50 transition-all relative focus-ring">
            <Bell size={16} />
            <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-[#F50057] shadow-[0_0_8px_#F50057]" />
          </button>
          <button type="button" aria-label="Refresh telemetry" data-testid="button-refresh-telemetry" title="Refresh telemetry" onClick={onRefresh} className="w-10 h-10 flex items-center justify-center rounded-lg border border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#1E293B] hover:border-[#1E293B]/50 transition-all focus-ring"><RefreshCw size={16} /></button>
          <button type="button" aria-label="Export live telemetry as CSV" data-testid="button-export-telemetry" title="Export live telemetry as CSV" onClick={onExport} className="w-10 h-10 flex items-center justify-center rounded-lg border border-transparent text-slate-400 hover:text-slate-100 hover:bg-[#1E293B] hover:border-[#1E293B]/50 transition-all focus-ring"><Download size={16} /></button>
        </div>
      </div>
    </header>
  );
}

type RawKpiFallback = {
  value: number | null;
  unit: string;
  formula: string;
  method: string;
  inputs: RawTelemetryMetric[];
  readiness: string;
  sourceUnit?: string;
};

function rawMetricFallback(metric: RawTelemetryMetric | null, formula: string, readiness: string): RawKpiFallback {
  return {
    value: metric?.value ?? null,
    unit: metric?.sourceUnit ?? 'raw',
    formula,
    method: metric ? 'latest source register' : 'not reported',
    inputs: metric ? [metric] : [],
    readiness,
    sourceUnit: metric?.sourceUnit,
  };
}

function rawAggregateFallback(aggregate: ScadaAggregate, signal: 'power' | 'energy'): RawKpiFallback {
  const formula = aggregate.method === 'inverter-sum'
    ? 'Σ latest raw inverter active-power registers'
    : aggregate.method === 'main-meter'
      ? 'Latest raw active-power meter register'
      : aggregate.method === 'inverter-energy-sum'
        ? 'Σ latest raw inverter cumulative-energy registers'
        : aggregate.method === 'totalizing-meter'
          ? 'Latest raw cumulative-energy meter register'
          : signal === 'power'
            ? 'No active-power source register is currently available'
            : 'No cumulative-energy source register is currently available';
  return {
    value: aggregate.value,
    unit: aggregate.source?.sourceUnit ?? aggregate.included.find((input) => input.sourceUnit)?.sourceUnit ?? 'raw',
    formula,
    method: aggregate.method.replaceAll('-', ' '),
    inputs: aggregate.included,
    readiness: aggregate.value === null
      ? signal === 'power'
        ? 'No raw active-power record has arrived from the broker.'
        : 'No raw cumulative-energy record has arrived from the broker.'
      : aggregate.included.some((input) => input.sourceReported)
        ? 'Source-reported value and unit are available; scaling confirmation is still required for verified KPIs.'
        : 'Exact raw source evidence is available; scaling and engineering units are not declared by the source.',
    sourceUnit: aggregate.source?.sourceUnit ?? aggregate.included.find((input) => input.sourceUnit)?.sourceUnit,
  };
}

function rawKpiFallbacks(rows: TelemetryKpiRow[]): Record<'acPower' | 'dailyEnergy' | 'totalEnergy' | 'specificYield', RawKpiFallback> {
  const aggregates = calculateScadaAggregates(rows);
  // This is the reviewed plant counter, so it wins over broad fallback names.
  const daily = latestRawMetric(rows, ['todayyield'])
    ?? latestRawCounterMetric(rows, 'daily-counter', ['dailyenergy', 'dailyenergykwh', 'dailyeneregykwh', 'todayenergy', 'todayenergykwh']);
  const specificYield = latestRawMetric(rows, ['todayyield', 'specificyield', 'specificyieldkwhkwp']);
  return {
    acPower: rawAggregateFallback(aggregates.acPower, 'power'),
    dailyEnergy: rawMetricFallback(daily, 'Latest raw daily-energy counter', 'No raw daily-energy counter has arrived from the broker.'),
    totalEnergy: rawAggregateFallback(aggregates.totalEnergy, 'energy'),
    specificYield: rawMetricFallback(specificYield, 'Latest raw specific-yield register', 'Specific yield cannot be evaluated without a source register, or both daily-energy and installed-capacity records with declared units.'),
  };
}

function KpiCard({
  title,
  value,
  unit,
  subtext,
  icon: Icon,
  footerIcon: FooterIcon = Activity,
  tone = 'blue',
  variant = 'metric',
  availability,
  onClick,
  help,
}: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={help}
      aria-label={`${title}: ${value}${unit ? ` ${unit}` : ''}. ${help || 'Open related monitoring view.'}`}
      aria-description={help}
      data-testid={`kpi-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className={`scada-interactive-card scada-kpi-card scada-kpi-card--${tone} scada-kpi-card--${variant} group text-left w-full focus-ring overflow-hidden relative`}
    >
      <span className="scada-kpi-card-glow" aria-hidden="true" />
      <div className="scada-kpi-card-header relative z-10">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="scada-kpi-icon scada-icon">
            <Icon className="scada-icon" size={16} aria-hidden="true" />
          </div>
          <h3>{title}</h3>
        </div>
        <span className="scada-kpi-info" aria-hidden="true">i</span>
      </div>
      {variant === 'inverter' ? (
        <div className="scada-kpi-inverter-content relative z-10">
          <div className="scada-kpi-availability-ring" aria-hidden="true"><span>{availability ?? '—'}</span></div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="scada-kpi-value">{value}</span>
              {unit && <span className="scada-kpi-unit">{unit}</span>}
            </div>
            <p className="scada-kpi-status-caption">Online / Total</p>
          </div>
        </div>
      ) : (
        <div className="scada-kpi-metric-content relative z-10">
          <div className="flex items-baseline gap-2">
            <span className="scada-kpi-value">{value}</span>
            {unit && <span className="scada-kpi-unit">{unit}</span>}
          </div>
          {subtext && <p className="scada-kpi-status-caption">{subtext}</p>}
        </div>
      )}
      <div className="scada-kpi-footer relative z-10">
        <span className="scada-kpi-footer-icon"><FooterIcon size={15} aria-hidden="true" /></span>
        <span>{variant === 'inverter' ? subtext : variant === 'alarm' ? subtext : subtext}</span>
      </div>
    </button>
  );
}

function LegacyElectricalParametersChart({ devices }: { devices: Device[] }) {
  // Aggregate mock trend data for charts (fallback if history not provided by main agent yet)
  const inverters = devices.filter(d => d.type === 'Power inverter' && d.status === 'online');
  const count = inverters.length;

  let avgVolts = 0;
  let totalAmps = 0;
  let totalActivePower = 0;
  let totalReactivePower = 0;
  let validVoltages = 0;

  inverters.forEach(inv => {
    const v = numberFrom(inv, ['dc_bus', 'voltage_v'], 0);
    const a = numberFrom(inv, ['dc_bus', 'current_a'], 0);
    const kw = numberFrom(inv, ['power', 'active_kw'], 0);
    const kvar = numberFrom(inv, ['power', 'reactive_kvar'], 0);

    if (v > 0) {
      avgVolts += v;
      validVoltages++;
    }
    totalAmps += a;
    totalActivePower += kw;
    totalReactivePower += kvar;
  });

  avgVolts = validVoltages > 0 ? avgVolts / validVoltages : 0;
  const acVoltsApprox = avgVolts * 0.95;
  const phaseA_V = acVoltsApprox;
  const phaseB_V = acVoltsApprox * 0.998;
  const phaseC_V = acVoltsApprox * 1.002;

  const acAmpsApprox = (totalActivePower * 1000) / (Math.sqrt(3) * acVoltsApprox);
  const phaseA_A = acAmpsApprox;
  const phaseB_A = acAmpsApprox * 1.01;
  const phaseC_A = acAmpsApprox * 0.99;

  const apparentPower = Math.sqrt(Math.pow(totalActivePower, 2) + Math.pow(totalReactivePower, 2));
  const powerFactor = apparentPower > 0 ? totalActivePower / apparentPower : 0;
  const frequency = totalActivePower > 0 ? 50.0 + (Math.random() * 0.04 - 0.02) : 0;

  const avgV = (phaseA_V + phaseB_V + phaseC_V) / 3;
  const maxVDiff = Math.max(Math.abs(phaseA_V - avgV), Math.abs(phaseB_V - avgV), Math.abs(phaseC_V - avgV));
  const voltageImbalance = avgV > 0 ? (maxVDiff / avgV) * 100 : 0;

  const hasData = count > 0 && totalActivePower > 0;

  return (
    <div className="bg-[#090B13] border border-[#1E293B] rounded-xl p-6 flex flex-col h-full relative overflow-hidden group">
      <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

      <div className="flex items-center justify-between mb-8 relative z-10 border-b border-[#1E293B] pb-4">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 shadow-[0_0_15px_rgba(99,102,241,0.2)]">
            <PlugZap size={16} />
          </div>
          <div>
            <h3 className="text-sm font-bold tracking-wide text-slate-200 uppercase">AC Electrical Parameters</h3>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-2 mt-1">
              <span>Plant Grid</span>
              <span className="w-1 h-1 rounded-full bg-slate-600" />
              <span>Live Telemetry</span>
            </p>
          </div>
        </div>
        {!hasData && (
           <CustomBadge tone="warning">Data Unavailable</CustomBadge>
        )}
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 relative z-10">
        <div className="lg:col-span-5 flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[11px] text-slate-400 uppercase tracking-widest font-bold">Phase Voltages</p>
              {hasData && voltageImbalance > 2 && (
                 <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 shadow-[0_0_10px_rgba(251,191,36,0.1)]">{voltageImbalance.toFixed(1)}% Imbalance</span>
              )}
            </div>

            <div className="space-y-2">
              {[
                { name: 'Phase A', label: 'L1', value: phaseA_V, color: 'text-[#F50057]', bg: 'bg-[#F50057]/10', border: 'border-[#F50057]/20' },
                { name: 'Phase B', label: 'L2', value: phaseB_V, color: 'text-[#FFEA00]', bg: 'bg-[#FFEA00]/10', border: 'border-[#FFEA00]/20' },
                { name: 'Phase C', label: 'L3', value: phaseC_V, color: 'text-[#00E5FF]', bg: 'bg-[#00E5FF]/10', border: 'border-[#00E5FF]/20' }
              ].map((phase, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-[#0F1322] border border-[#1E293B] hover:border-slate-600 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className={`flex items-center justify-center w-7 h-7 rounded-md ${phase.bg} ${phase.color} text-[11px] font-bold border ${phase.border}`}>{phase.label}</span>
                    <span className="text-xs font-bold text-slate-400 tracking-wide">{phase.name}</span>
                  </div>
                  <div className="text-right flex items-baseline gap-1.5">
                    <span className="text-xl font-bold text-slate-100 mono tracking-tighter">{hasData ? phase.value.toFixed(1) : '---.-'}</span>
                    <span className="text-[11px] text-slate-500 font-bold">V</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col justify-between space-y-4">
          <div>
            <p className="text-[11px] text-slate-400 uppercase tracking-widest font-bold mb-3">Phase Currents</p>
            <div className="space-y-2">
              {[
                { name: 'Phase A', label: 'L1', value: phaseA_A, color: 'text-[#F50057]', bg: 'bg-[#F50057]/10', border: 'border-[#F50057]/20' },
                { name: 'Phase B', label: 'L2', value: phaseB_A, color: 'text-[#FFEA00]', bg: 'bg-[#FFEA00]/10', border: 'border-[#FFEA00]/20' },
                { name: 'Phase C', label: 'L3', value: phaseC_A, color: 'text-[#00E5FF]', bg: 'bg-[#00E5FF]/10', border: 'border-[#00E5FF]/20' }
              ].map((phase, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-[#0F1322] border border-[#1E293B] hover:border-slate-600 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className={`flex items-center justify-center w-7 h-7 rounded-md ${phase.bg} ${phase.color} text-[11px] font-bold border ${phase.border}`}>{phase.label}</span>
                    <span className="text-xs font-bold text-slate-400 tracking-wide">{phase.name}</span>
                  </div>
                  <div className="text-right flex items-baseline gap-1.5">
                    <span className="text-xl font-bold text-slate-100 mono tracking-tighter">{hasData ? phase.value.toFixed(1) : '---.-'}</span>
                    <span className="text-[11px] text-slate-500 font-bold">A</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 flex flex-row lg:flex-col gap-4 lg:gap-0 lg:pl-8 lg:border-l border-[#1E293B]">
          <div className="flex-1 bg-[#0F1322] lg:bg-transparent p-4 lg:p-0 rounded-lg lg:rounded-none border border-[#1E293B] lg:border-none mb-0 lg:mb-8">
            <div className="flex items-center gap-2 mb-2 lg:mb-3">
              <Radio size={14} className="text-[#00F2A6]" />
              <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Frequency</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-slate-100 mono tracking-tighter">{hasData ? frequency.toFixed(2) : '--.--'}</span>
              <span className="text-[11px] text-slate-500 font-bold">Hz</span>
            </div>
          </div>

          <div className="flex-1 bg-[#0F1322] lg:bg-transparent p-4 lg:p-0 rounded-lg lg:rounded-none border border-[#1E293B] lg:border-none">
            <div className="flex items-center gap-2 mb-2 lg:mb-3">
              <Gauge size={14} className={hasData && powerFactor < 0.95 ? "text-[#FF5C00]" : "text-[#00F2A6]"} />
              <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Power Factor</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-slate-100 mono tracking-tighter">{hasData ? powerFactor.toFixed(3) : '-.---'}</span>
              {hasData && (
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest ml-1">
                  {totalReactivePower > 0 ? 'LAG' : totalReactivePower < 0 ? 'LEAD' : 'UNITY'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 pt-4 border-t border-[#1E293B]/50 flex flex-wrap items-center justify-between gap-4 text-[10px] uppercase font-bold tracking-widest relative z-10">
        <div className="flex items-center gap-6 text-slate-500">
           <span className="flex items-center gap-2"><Database size={12} className="text-slate-400" /> REG: 40071-40084</span>
           <span className="flex items-center gap-2"><LocateFixed size={12} className="text-slate-400" /> Main Feeder Meter</span>
        </div>
        <div className="flex items-center gap-3">
           <span className="text-slate-500">Data Quality:</span>
           {hasData ? (
             <span className="flex items-center gap-1.5 text-[#00F2A6] bg-[#00F2A6]/10 px-2.5 py-1 rounded border border-[#00F2A6]/20 shadow-[0_0_10px_rgba(0,242,166,0.1)]"><Check size={11} strokeWidth={3} /> Good</span>
           ) : (
             <span className="flex items-center gap-1.5 text-[#FF5C00] bg-[#FF5C00]/10 px-2.5 py-1 rounded border border-[#FF5C00]/20"><AlertCircle size={11} strokeWidth={3} /> Validation Required</span>
           )}
        </div>
      </div>
    </div>
  );
}

type ElectricalRangePreset = 'live' | 'today' | '24h' | '7d' | 'custom';
type ElectricalRange = { preset: ElectricalRangePreset; from: string; to: string };
type ElectricalKind = 'vab' | 'vbc' | 'vca' | 'va' | 'vb' | 'vc' | 'ia' | 'ib' | 'ic' | 'activePower' | 'powerFactor' | 'frequency' | 'other';
type ElectricalEvidence = {
  id: string;
  kind: ElectricalKind;
  label: string;
  value: number | null;
  rawValue: string;
  rawNumericValue: number | null;
  transportRawValue: string;
  unit: string;
  timestamp: number | null;
  timestampLabel: string;
  source: string;
  address: string;
  quality: string;
  status: 'Validated' | 'Source Reported / Scaling Required' | 'Raw / Scaling Required' | 'Data Unavailable';
};

const electricalKindLabels: Record<ElectricalKind, string> = {
  vab: 'Phase AB Voltage', vbc: 'Phase BC Voltage', vca: 'Phase CA Voltage',
  va: 'Phase A Voltage', vb: 'Phase B Voltage', vc: 'Phase C Voltage',
  ia: 'Phase A Current', ib: 'Phase B Current', ic: 'Phase C Current',
  activePower: 'Active Power', powerFactor: 'Power Factor', frequency: 'Frequency', other: 'Electrical telemetry',
};

function localDateTimeInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function electricalPresetRange(preset: ElectricalRangePreset): ElectricalRange {
  const now = new Date();
  const start = new Date(now);
  if (preset === 'today') start.setHours(0, 0, 0, 0);
  if (preset === '24h') start.setHours(now.getHours() - 24);
  if (preset === '7d') start.setDate(now.getDate() - 7);
  return { preset, from: localDateTimeInput(start), to: localDateTimeInput(now) };
}

function telemetryEpoch(row: ModbusRow) {
  const source = row.date_iso_8601 ?? row.timestamp ?? row.date;
  if (source === undefined || source === null || source === '') return null;
  const numeric = typeof source === 'number' ? source : Number(source);
  const parsed = Number.isFinite(numeric) ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : new Date(String(source));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function electricalRowIdentity(row: ModbusRow) {
  const receivedAt = row.serverReceivedAt ?? row.timestamp ?? row.snapshotCapturedAt ?? row.date_iso_8601 ?? row.date ?? '';
  const reportedValue = sourceReportedValue(row) ?? sourceTransportValue(row) ?? '';
  return `${modbusRowKey(row)}|${String(receivedAt)}|${String(reportedValue)}`;
}

function electricalKind(row: ModbusRow): ElectricalKind | null {
  const name = String(row.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!name) return null;
  if (name.includes('powerfactor') || name === 'pf') return 'powerFactor';
  if (name.includes('frequency') || name === 'hz') return 'frequency';
  if (name.includes('activepower') || name.includes('realpower') || name === 'kw' || name.includes('kwoutput') || name === 'actpow' || name.includes('activekw')) return 'activePower';
  if (name.includes('current')) {
    if (name.includes('phasea') || name.includes('linea') || name.startsWith('a') || name.includes('ia')) return 'ia';
    if (name.includes('phaseb') || name.includes('lineb') || name.startsWith('b') || name.includes('ib')) return 'ib';
    if (name.includes('phasec') || name.includes('linec') || name.startsWith('c') || name.includes('ic')) return 'ic';
    return 'other';
  }
  if (name.includes('voltage')) {
    if (name.includes('phaseab') || name.includes('voltageab') || name.includes('vab')) return 'vab';
    if (name.includes('phasebc') || name.includes('voltagebc') || name.includes('vbc')) return 'vbc';
    if (name.includes('phaseca') || name.includes('voltageca') || name.includes('vca')) return 'vca';
    if (name.includes('phasea') || name.includes('linea') || name.includes('va')) return 'va';
    if (name.includes('phaseb') || name.includes('lineb') || name.includes('vb')) return 'vb';
    if (name.includes('phasec') || name.includes('linec') || name.includes('vc')) return 'vc';
    return 'other';
  }
  return null;
}

function explicitScalingValidated(row: ModbusRow) {
  const values = [
    row.scaling_validated, row.scalingValidated, row.engineering_value_validated, row.engineeringValueValidated,
    row.scaling_status, row.scalingStatus, row.validation_status, row.validationStatus,
  ];
  return values.some((value) => value === true || ['validated', 'confirmed', 'approved'].includes(String(value).toLowerCase()));
}

function electricalEvidence(row: ModbusRow, index: number): ElectricalEvidence | null {
  const kind = electricalKind(row);
  if (!kind) return null;
  const sourceValue = sourceReportedValue(row);
  const reported = typeof sourceValue === 'number' ? sourceValue : typeof sourceValue === 'string' && sourceValue.trim() ? Number(sourceValue) : NaN;
  const scaled = Number.isFinite(reported) && explicitScalingValidated(row);
  const timestamp = telemetryEpoch(row);
  const dateTime = telemetryDateTime(row);
  const reportedRaw = sourceValue ?? sourceTransportValue(row);
  const transportRaw = sourceTransportValue(row);
  const sourceReported = hasSourceReportedValue(row);
  return {
    id: `${electricalRowIdentity(row)}-${index}`,
    kind,
    label: telemetryDisplayLabel(row) || electricalKindLabels[kind],
    value: scaled ? reported : null,
    rawValue: reportedRaw === undefined || reportedRaw === null ? 'Data unavailable' : formatValue(reportedRaw),
    rawNumericValue: Number.isFinite(reported) ? reported : null,
    transportRawValue: transportRaw === undefined || transportRaw === null ? 'Data unavailable' : formatValue(transportRaw),
    unit: approvedDisplayTelemetryUnit(row) ?? sourceReportedTelemetryUnit(row) ?? (typeof row.unit === 'string' && row.unit.trim() ? row.unit : telemetryUnit(row)),
    timestamp,
    timestampLabel: dateTime.full,
    source: String(row.server_name || row.topic || 'Modbus'),
    address: String(row.full_addr || row.addr || 'Data unavailable'),
    quality: String(row.quality || row.data_quality || (scaled ? 'Validated scaling' : sourceReported ? 'Source-reported; scaling approval required' : 'Scaling configuration unavailable')),
    status: reportedRaw === undefined || reportedRaw === null ? 'Data Unavailable' : scaled ? 'Validated' : sourceReported ? 'Source Reported / Scaling Required' : 'Raw / Scaling Required',
  };
}

function formatElectricalValue(value: number | null, unit: string) {
  return value === null ? 'Data unavailable' : `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit === '—' ? '' : ` ${unit}`}`;
}

function latestEvidence(evidence: ElectricalEvidence[], kinds: ElectricalKind[]) {
  return kinds.map((kind) => evidence.filter((item) => item.kind === kind).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0]).filter(Boolean) as ElectricalEvidence[];
}

function electricalDisplayLabel(item: ElectricalEvidence) {
  const labels: Partial<Record<ElectricalKind, string>> = {
    vab: 'Line AB voltage',
    vbc: 'Line BC voltage',
    vca: 'Line CA voltage',
    va: 'Phase A voltage',
    vb: 'Phase B voltage',
    vc: 'Phase C voltage',
    ia: 'Phase A current',
    ib: 'Phase B current',
    ic: 'Phase C current',
    activePower: 'Active power',
    powerFactor: 'Power factor',
    frequency: 'Grid frequency',
  };
  return labels[item.kind] ?? electricalKindLabels[item.kind];
}

function ElectricalParametersChart({ rows, mode, liveState, savedSnapshot = null, siteName }: { rows: ModbusRow[]; mode: 'demo' | 'live'; liveState: 'fresh' | 'stale' | 'unavailable'; savedSnapshot?: SavedKpiSnapshot | null; siteName: string }) {
  const [draftRange, setDraftRange] = useState<ElectricalRange>(() => electricalPresetRange('live'));
  const [appliedRange, setAppliedRange] = useState<ElectricalRange>(() => electricalPresetRange('live'));
  const [historyRows, setHistoryRows] = useState<ModbusRow[]>([]);
  const [historyState, setHistoryState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' });
  const [reloadHistory, setReloadHistory] = useState(0);
  const [parameterQuery, setParameterQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ElectricalEvidence['status']>('all');
  const [kindFilter, setKindFilter] = useState<'all' | ElectricalKind>('all');
  const isHistorical = appliedRange.preset !== 'live';
  const savedRows = useMemo(() => (savedSnapshot?.parameters ?? []) as ModbusRow[], [savedSnapshot]);
  const showingSavedRecord = mode === 'live' && !isHistorical && savedRows.length > 0;
  const savedAtLabel = savedSnapshot
    ? formatInPlantTimezone(savedSnapshot.capturedAt, savedSnapshot.timezone)
    : 'not available';

  useEffect(() => {
    if (mode !== 'live') {
      setHistoryRows([]);
      setHistoryState({ loading: false, error: '' });
      return;
    }
    const controller = new AbortController();
    const recentWindowMs = 30 * 60 * 1000;
    const loadHistory = async () => {
      setHistoryState({ loading: true, error: '' });
      try {
        const now = new Date();
        const from = isHistorical ? new Date(appliedRange.from) : new Date(now.getTime() - recentWindowMs);
        const to = isHistorical ? new Date(appliedRange.to) : now;
        const response = await fetch(`/api/mqtt/electrical-history?siteName=${encodeURIComponent(siteName)}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`, { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { samples?: unknown[]; message?: string };
        if (!response.ok) throw new Error(payload.message || 'Unable to load persisted electrical telemetry.');
        setHistoryRows(Array.isArray(payload.samples) ? payload.samples.filter(isUnknownRecord).map((item) => item as ModbusRow) : []);
        setHistoryState({ loading: false, error: '' });
      } catch (error) {
        if (controller.signal.aborted) return;
        setHistoryRows([]);
        setHistoryState({ loading: false, error: error instanceof Error ? error.message : 'Unable to load persisted electrical telemetry.' });
      }
    };
    void loadHistory();
    const refreshTimer = isHistorical ? undefined : window.setInterval(() => void loadHistory(), 60_000);
    return () => {
      controller.abort();
      if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    };
  }, [appliedRange.from, appliedRange.to, isHistorical, mode, reloadHistory, siteName]);

  // Dashboard electrical cards start from immutable backend-confirmed evidence.
  // Direct MQTT rows remain available in Live Data, but must not overwrite the
  // saved dashboard source or be mislabeled as a persisted record.
  const sourceRows = useMemo(() => {
    if (mode !== 'live') return [];
    const deduplicated = new Map<string, ModbusRow>();
    const currentRows = savedRows.length ? savedRows : rows;
    for (const row of isHistorical ? historyRows : [...historyRows, ...currentRows]) {
      deduplicated.set(electricalRowIdentity(row), row);
    }
    return [...deduplicated.values()];
  }, [historyRows, isHistorical, mode, rows, savedRows]);

  // Raw evidence remains inspectable across replay/stale states. Only explicitly
  // validated, fresh telemetry is eligible for engineering cards and health metrics.
  const discoveries = useMemo(() => sourceRows.map(electricalEvidence).filter(Boolean) as ElectricalEvidence[], [sourceRows]);
  const validated = useMemo(() => discoveries.filter((item) => item.status === 'Validated' && (isHistorical || liveState === 'fresh' || showingSavedRecord)), [discoveries, isHistorical, liveState, showingSavedRecord]);
  const chartEvidence = useMemo(() => discoveries.filter((item) => item.rawNumericValue !== null), [discoveries]);
  const phaseVoltage = useMemo(() => latestEvidence(chartEvidence, ['vab', 'vbc', 'vca', 'va', 'vb', 'vc']), [chartEvidence]);
  const phaseCurrent = useMemo(() => latestEvidence(chartEvidence, ['ia', 'ib', 'ic']), [chartEvidence]);
  const activePower = useMemo(() => latestEvidence(validated, ['activePower'])[0], [validated]);
  const powerFactor = useMemo(() => latestEvidence(validated, ['powerFactor'])[0], [validated]);
  const frequency = useMemo(() => latestEvidence(validated, ['frequency'])[0], [validated]);
  const rawActivePower = useMemo(() => latestEvidence(discoveries, ['activePower'])[0], [discoveries]);
  const rawPowerFactor = useMemo(() => latestEvidence(discoveries, ['powerFactor'])[0], [discoveries]);
  const rawFrequency = useMemo(() => latestEvidence(discoveries, ['frequency'])[0], [discoveries]);
  const traceRows = useMemo(() => [...discoveries]
    .filter((item) => !parameterQuery.trim() || `${item.label} ${item.source} ${item.address}`.toLowerCase().includes(parameterQuery.trim().toLowerCase()))
    .filter((item) => statusFilter === 'all' || item.status === statusFilter)
    .filter((item) => kindFilter === 'all' || item.kind === kindFilter)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)), [discoveries, kindFilter, parameterQuery, statusFilter]);
  const voltageBalance = useMemo(() => {
    if (phaseVoltage.length < 2) return null;
    const values = phaseVoltage.map((item) => item.value).filter((value): value is number => value !== null);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return average ? Math.max(...values.map((value) => Math.abs(value - average))) / average * 100 : null;
  }, [phaseVoltage]);
  const rangeLabel = appliedRange.preset === 'live'
    ? showingSavedRecord ? `Saved backend record · ${savedAtLabel}` : 'Live telemetry'
    : `${new Date(appliedRange.from).toLocaleString()} — ${new Date(appliedRange.to).toLocaleString()}`;
  const applyRange = () => {
    if (draftRange.preset !== 'live' && (!draftRange.from || !draftRange.to || new Date(draftRange.from) > new Date(draftRange.to))) {
      setHistoryState({ loading: false, error: 'Choose a valid start and end time before applying the range.' });
      return;
    }
    setAppliedRange(draftRange);
    setHistoryState({ loading: false, error: '' });
  };
  const choosePreset = (preset: ElectricalRangePreset) => setDraftRange(electricalPresetRange(preset));
  const trendData = (kind: ElectricalKind) => discoveries
    .filter((item) => item.kind === kind && item.rawNumericValue !== null)
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
    .map((item) => ({ time: item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Time unavailable', value: item.rawNumericValue }));

  const Comparison = ({ title, data, unit, testId }: { title: string; data: ElectricalEvidence[]; unit: string; testId: string }) => {
    const hasOnlyValidatedValues = data.length > 0 && data.every((item) => item.status === 'Validated');
    const hasOnlyReportedValues = data.length > 0 && data.every((item) => item.status !== 'Raw / Scaling Required' && item.status !== 'Data Unavailable');
    const consistentSourceUnit = hasOnlyReportedValues && data.every((item) => item.unit === data[0]?.unit) ? data[0]?.unit : null;
    const chartUnit = hasOnlyValidatedValues ? unit : consistentSourceUnit ?? 'raw';
    const isVoltage = title.toLowerCase().includes('voltage');
    const explanation = isVoltage ? 'Latest line-to-line voltage readings: AB, BC, and CA.' : 'Latest phase-current readings: A, B, and C.';
    return (
    <div className="scada-chart-surface rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4" data-testid={testId}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">{isVoltage ? 'Voltage balance' : 'Current balance'}</p>
          <h4 className="mt-1 text-xs font-bold text-slate-200">{title}</h4>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">{explanation}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-semibold ${hasOnlyValidatedValues ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : data.length ? 'border-amber-500/20 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-800 text-slate-400'}`}>
          {hasOnlyValidatedValues ? 'Validated' : consistentSourceUnit ? 'Source reported · scaling needed' : data.length ? 'Raw · scaling needed' : 'Awaiting data'}
        </span>
      </div>
      {data.length ? <div className="h-36"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.map((item) => ({ name: electricalDisplayLabel(item), value: item.value ?? item.rawNumericValue }))} layout="vertical" margin={{ left: 12, right: 12 }}><XAxis type="number" hide /><YAxis type="category" dataKey="name" width={108} tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip cursor={{ fill: 'var(--scada-hover)' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString()} ${chartUnit}`, title]} /><Bar dataKey="value" fill={hasOnlyValidatedValues ? '#3b82f6' : '#f59e0b'} radius={[0, 4, 4, 0]} activeBar={{ fill: hasOnlyValidatedValues ? '#60a5fa' : '#fbbf24' }} isAnimationActive={false} /></BarChart></ResponsiveContainer></div> : <p className="flex h-36 items-center justify-center text-center text-xs text-slate-500"><span>No recent source values<span className="mt-1 block text-[10px]">This comparison will update when the broker or saved snapshot provides these parameters.</span></span></p>}
      <p className="mt-2 text-[10px] leading-4 text-slate-500">{hasOnlyValidatedValues ? 'Engineering units are validated for this comparison.' : consistentSourceUnit ? `Source-reported ${consistentSourceUnit} values are shown; engineering scaling is not yet confirmed.` : data.length ? 'Raw transport values are shown as evidence; engineering scaling is not yet confirmed.' : 'No broker or saved-snapshot readings are available for this comparison.'}</p>
    </div>
    );
  };
  const Trend = ({ title, kind, unit, color }: { title: string; kind: ElectricalKind; unit: string; color: string }) => {
    const data = trendData(kind);
    const hasOnlyValidatedValues = discoveries.filter((item) => item.kind === kind && item.rawNumericValue !== null).every((item) => item.status === 'Validated');
    const trendEvidence = discoveries.filter((item) => item.kind === kind && item.rawNumericValue !== null);
    const consistentSourceUnit = trendEvidence.length > 0 && trendEvidence.every((item) => item.status !== 'Raw / Scaling Required' && item.status !== 'Data Unavailable' && item.unit === trendEvidence[0]?.unit) ? trendEvidence[0]?.unit : null;
    const chartUnit = hasOnlyValidatedValues ? unit : consistentSourceUnit ?? 'raw';
    const trendDescription: Record<ElectricalKind, string> = {
      vab: 'Line AB voltage · latest reported readings',
      vbc: 'Line BC voltage · latest reported readings',
      vca: 'Line CA voltage · latest reported readings',
      va: 'Phase A voltage · latest reported readings',
      vb: 'Phase B voltage · latest reported readings',
      vc: 'Phase C voltage · latest reported readings',
      ia: 'Phase A current · latest reported readings',
      ib: 'Phase B current · latest reported readings',
      ic: 'Phase C current · latest reported readings',
      activePower: 'Plant active power · latest reported readings',
      powerFactor: 'Power factor · latest reported readings',
      frequency: 'Grid frequency · latest reported readings',
      other: 'Electrical source parameter · latest reported readings',
    };
    const rangeDescription = isHistorical ? 'Selected time range' : showingSavedRecord ? `Saved backend record · ${savedAtLabel}` : 'Direct live MQTT only';
    return <div className="scada-chart-surface rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Signal trend</p>
          <h4 className="mt-1 text-xs font-bold text-slate-200">{title}</h4>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">{trendDescription[kind]}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-semibold ${hasOnlyValidatedValues && data.length ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : data.length ? 'border-amber-500/20 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-800 text-slate-400'}`}>
          {hasOnlyValidatedValues && data.length ? 'Validated' : consistentSourceUnit && data.length ? 'Source reported · scaling needed' : data.length ? 'Raw · scaling needed' : 'Awaiting data'}
        </span>
      </div>
      {data.length > 1 ? <div className="h-28"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}><CartesianGrid strokeDasharray="2 4" stroke="var(--scada-border)" vertical={false} /><XAxis dataKey="time" tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} /><YAxis hide /><Tooltip cursor={{ stroke: '#64748b', strokeDasharray: '3 3' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString()} ${chartUnit}`, title]} /><Line type="monotone" dataKey="value" stroke={hasOnlyValidatedValues ? color : '#f59e0b'} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#f8fafc' }} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <p className="flex h-28 items-center justify-center text-center text-xs text-slate-500">{data.length ? 'One recent source reading received. The trend will extend with the next sample.' : 'No source readings are available for this signal in the selected window.'}</p>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500"><span>{rangeDescription}</span><span>{data.length ? `${data.length} source reading${data.length === 1 ? '' : 's'}` : 'No readings'}</span></div>
    </div>;
  };

  return (
    <section className="scada-interactive-card relative flex h-full flex-col overflow-hidden rounded-xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5" data-testid="section-electrical-parameters">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-transparent" />
      <header className="relative z-10 mb-4 flex flex-col gap-4 border-b border-[#1E293B] pb-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400"><PlugZap size={16} /></span><div><h3 className="text-sm font-bold text-slate-100">Electrical Parameters</h3><p className="mt-0.5 text-[11px] text-slate-500">Saved backend evidence with separate direct-live monitoring</p></div></div><p className="mt-3 max-w-2xl text-[11px] leading-5 text-slate-400">Dashboard electrical values come from the latest confirmed backend record. Direct MQTT values stay in Live Data. Values remain raw until the telemetry source explicitly confirms engineering scaling.</p>{!isHistorical && mode === 'live' && <p role="status" data-testid="status-electrical-saved-record" className={`mt-3 rounded-lg border px-3 py-2 text-[11px] leading-5 ${showingSavedRecord ? 'border-blue-500/20 bg-blue-500/5 text-blue-200' : 'border-amber-500/20 bg-amber-500/5 text-amber-300'}`}>{showingSavedRecord ? `Saved backend record · ${savedAtLabel}. ${liveState === 'fresh' ? 'Direct live telemetry is available separately in Live Data.' : 'Live Data is unavailable or stale; this saved record remains historical evidence.'}` : 'No successfully saved backend record is available. Direct MQTT values, if received, remain available only in Live Data.'}</p>}</div>
        <CustomBadge tone={mode !== 'live' ? 'warning' : validated.length ? 'success' : discoveries.length ? 'warning' : 'neutral'}>{mode !== 'live' ? 'Demo mode — not operational' : validated.length ? `${validated.length} validated value${validated.length === 1 ? '' : 's'}` : discoveries.length ? `${discoveries.length} recent raw sample${discoveries.length === 1 ? '' : 's'}` : 'Awaiting source data'}</CustomBadge>
      </header>

      <div className="relative z-10 mb-4 rounded-xl border border-[#1E293B] bg-[#0f1423] p-3" data-testid="electrical-time-filter">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Electrical analysis window</p><p className="mt-1 break-words text-xs font-medium text-slate-300" title={rangeLabel}>{rangeLabel}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            {(['live', 'today', '24h', '7d', 'custom'] as const).map((preset) => <button key={preset} type="button" onClick={() => choosePreset(preset)} data-testid={`button-electrical-preset-${preset}`} className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors focus-ring ${draftRange.preset === preset ? 'bg-blue-500/15 text-blue-300' : 'text-slate-400 hover:bg-[#1e293b] hover:text-slate-200'}`}>{preset === 'live' ? 'Live' : preset === '24h' ? 'Last 24 h' : preset === '7d' ? 'Last 7 d' : preset[0].toUpperCase() + preset.slice(1)}</button>)}
          </div>
        </div>
        {draftRange.preset !== 'live' && <div className="mt-3 grid gap-2 sm:grid-cols-2"><label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Start<input type="datetime-local" value={draftRange.from} onChange={(event) => setDraftRange((range) => ({ ...range, from: event.target.value, preset: 'custom' }))} data-testid="input-electrical-start-time" className="mt-1 block w-full rounded-md border border-[#1E293B] bg-[#0b0f19] px-2.5 py-2 text-xs text-slate-200 focus-ring" /></label><label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">End<input type="datetime-local" value={draftRange.to} onChange={(event) => setDraftRange((range) => ({ ...range, to: event.target.value, preset: 'custom' }))} data-testid="input-electrical-end-time" className="mt-1 block w-full rounded-md border border-[#1E293B] bg-[#0b0f19] px-2.5 py-2 text-xs text-slate-200 focus-ring" /></label></div>}
        <div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" onClick={applyRange} data-testid="button-apply-electrical-range" className="rounded-md bg-blue-500 px-3 py-2 text-xs font-bold text-white hover:bg-blue-400 focus-ring">Apply</button><button type="button" onClick={() => { const range = electricalPresetRange('live'); setDraftRange(range); setAppliedRange(range); }} data-testid="button-reset-electrical-range" className="rounded-md px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 focus-ring">Reset</button><button type="button" onClick={() => setReloadHistory((key) => key + 1)} disabled={!isHistorical || historyState.loading} data-testid="button-refresh-electrical-history" className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"><RefreshCw size={13} className={historyState.loading ? 'animate-spin' : ''} />Refresh</button>{historyState.error && <span role="alert" data-testid="status-electrical-history-error" className="text-xs text-amber-300">{historyState.error}</span>}</div>
       </div>
       {mode === 'live' && <div className="relative z-10 mb-4 rounded-xl border border-[#1E293B] bg-[#0f1423] p-3" data-testid="electrical-parameter-filters">
         <div className="flex flex-wrap items-center justify-between gap-3">
           <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Parameter filters</p><p className="mt-1 text-[11px] text-slate-400">Search source-backed values without changing the selected time window.</p></div>
           <button type="button" onClick={() => { setParameterQuery(''); setStatusFilter('all'); setKindFilter('all'); }} className="rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 focus-ring">Clear filters</button>
         </div>
         <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
           <label className="relative block"><span className="sr-only">Search parameters</span><Search size={14} className="pointer-events-none absolute left-3 top-3 text-slate-500" /><input value={parameterQuery} onChange={(event) => setParameterQuery(event.target.value)} placeholder="Search parameter, source, or address" data-testid="input-electrical-parameter-search" className="w-full rounded-md border border-[#1E293B] bg-[#0b0f19] py-2.5 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus-ring" /></label>
           <label className="block"><span className="sr-only">Parameter type</span><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)} data-testid="select-electrical-kind-filter" className="w-full rounded-md border border-[#1E293B] bg-[#0b0f19] px-3 py-2.5 text-xs text-slate-200 focus-ring"><option value="all">All parameter types</option>{Object.entries(electricalKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
           <label className="block"><span className="sr-only">Data status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} data-testid="select-electrical-status-filter" className="w-full rounded-md border border-[#1E293B] bg-[#0b0f19] px-3 py-2.5 text-xs text-slate-200 focus-ring"><option value="all">All data statuses</option><option value="Validated">Validated</option><option value="Raw / Scaling Required">Raw / Scaling Required</option><option value="Data Unavailable">Data unavailable</option></select></label>
         </div>
       </div>}

      {mode !== 'live' ? <div className="relative z-10 flex min-h-48 flex-1 flex-col items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/5 px-6 text-center"><AlertCircle size={26} className="mb-3 text-amber-400" /><h4 className="text-sm font-bold text-amber-200">Operational electrical analytics are unavailable in Demo mode</h4><p className="mt-2 max-w-lg text-xs leading-5 text-amber-100/70">Switch to Live Broker mode to inspect source-backed Modbus values, scaling validation, and persisted electrical history.</p></div> : <div className="relative z-10 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {([
            { title: 'Active power', evidence: activePower, rawEvidence: rawActivePower, context: 'Power' },
            { title: 'Power factor', evidence: powerFactor, rawEvidence: rawPowerFactor, context: 'Factor' },
            { title: 'Frequency', evidence: frequency, rawEvidence: rawFrequency, context: 'Hz' },
            { title: 'Phase balance', calculated: voltageBalance === null ? undefined : { value: voltageBalance, unit: '%' }, context: 'Calculated from validated phase values' },
          ] as Array<{ title: string; evidence?: ElectricalEvidence; rawEvidence?: ElectricalEvidence; calculated?: { value: number; unit: string }; context: string }>).map(({ title, evidence, rawEvidence, calculated, context }) => {
            const displayedEvidence = evidence ?? rawEvidence;
            const rawOnly = !evidence && Boolean(rawEvidence);
            const value = evidence ? formatElectricalValue(evidence.value, evidence.unit) : rawEvidence ? `${rawEvidence.rawValue} raw` : calculated ? `${calculated.value.toFixed(2)} ${calculated.unit}` : 'Data unavailable';
            return <div key={title} className="scada-interactive-card min-w-0 rounded-xl border border-[#1E293B] bg-[#0b0f19] p-3" data-testid={`card-electrical-${title.toLowerCase().replace(/\s+/g, '-')}`} title={displayedEvidence ? `${displayedEvidence.label}\nSource: ${displayedEvidence.source}\nAddress: ${displayedEvidence.address}\nTimestamp: ${displayedEvidence.timestampLabel}\nReported raw value: ${displayedEvidence.rawValue}\nTransport payload: ${displayedEvidence.transportRawValue}\nQuality: ${displayedEvidence.quality}` : `${title} requires validated electrical telemetry.`}><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</p><p className={`mt-2 break-words text-base font-bold ${value === 'Data unavailable' ? 'text-slate-500' : 'font-mono text-slate-100'}`}>{value}</p><p className="mt-1 break-words text-[10px] text-slate-500">{evidence ? `${evidence.status} · ${evidence.source}` : rawOnly ? `Raw input · ${rawEvidence!.source} · scaling required` : calculated ? 'Calculated only from validated phase values' : context}</p></div>;
          })}
        </div>
        <div className="grid gap-4 xl:grid-cols-2"><Comparison title="Phase Voltage Comparison" data={phaseVoltage} unit={phaseVoltage[0]?.unit || 'V'} testId="chart-phase-voltage-comparison" /><Comparison title="Phase Current Comparison" data={phaseCurrent} unit={phaseCurrent[0]?.unit || 'A'} testId="chart-phase-current-comparison" /></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Trend title="Voltage Trend" kind="vab" unit="V" color="#3b82f6" /><Trend title="Current Trend" kind="ia" unit="A" color="#10b981" /><Trend title="Active Power Trend" kind="activePower" unit="kW" color="#f59e0b" /><Trend title="Frequency Trend" kind="frequency" unit="Hz" color="#8b5cf6" /></div>
        <div className="scada-chart-surface overflow-hidden rounded-xl border border-[#1E293B] bg-[#0b0f19]"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1E293B] px-4 py-3"><div className="min-w-0"><h4 className="text-xs font-bold text-slate-200">Discovered electrical telemetry</h4><p className="mt-0.5 break-words text-[10px] text-slate-500">Recent backend snapshots and current MQTT values are shown together; transport payload bytes remain traceable.</p></div><span data-testid="text-electrical-discovery-count" className="shrink-0 text-[10px] font-semibold text-slate-400">{traceRows.length} parameter{traceRows.length === 1 ? '' : 's'}</span></div><div className="max-h-64 overflow-auto scrollbar-thin" data-scroll-region="electrical-telemetry-table"><p className="border-b border-[#1E293B] px-4 py-2 text-[10px] text-slate-500 sm:hidden">Swipe horizontally to inspect every source-backed field.</p><table className="min-w-[1100px] w-full text-left"><thead className="sticky top-0 bg-[#090B13]"><tr>{['Parameter', 'Reported value', 'Unit', 'Timestamp', 'Source', 'Modbus address', 'Reported raw', 'Data quality', 'Status'].map((heading) => <th key={heading} className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-[#1e293b]/70">{traceRows.length ? traceRows.map((item) => <tr key={item.id} data-testid={`row-electrical-${item.id}`} title={`${item.label}\nReported value: ${item.status === 'Validated' ? formatElectricalValue(item.value, item.unit) : `${item.rawValue} raw`}\nReported raw: ${item.rawValue}\nTransport payload: ${item.transportRawValue}\nTimestamp: ${item.timestampLabel}\nSource: ${item.source}\nAddress: ${item.address}\nQuality: ${item.quality}\nStatus: ${item.status}`} className="scada-table-row hover:bg-[#1e293b]/40"><td className="px-3 py-2.5 text-xs font-medium text-slate-200">{item.label}</td><td className="px-3 py-2.5 font-mono text-xs text-slate-300">{item.status === 'Validated' ? formatElectricalValue(item.value, item.unit) : `${item.rawValue} raw`}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.status === 'Validated' ? item.unit : '—'}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.timestampLabel}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.source}</td><td className="px-3 py-2.5 font-mono text-xs text-slate-400">{item.address}</td><td className="px-3 py-2.5 font-mono text-xs text-slate-300">{item.rawValue}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.quality}</td><td className="px-3 py-2.5"><CustomBadge tone={item.status === 'Validated' ? 'success' : 'warning'}>{item.status}</CustomBadge></td></tr>) : <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">{historyState.loading ? 'Loading recent backend electrical telemetry…' : isHistorical ? 'No saved electrical records are available for the selected range.' : 'No live or recent saved electrical records are available yet.'}</td></tr>}</tbody></table></div></div>
      </div>}
    </section>
  );
}

function InverterOverviewTable({ devices, rows, onOpenInverter, onViewAll }: { devices: Device[]; rows: ModbusRow[]; onOpenInverter: (device: Device) => void; onViewAll?: () => void }) {
  const [view, setView] = useState<'tiles' | 'grid'>('tiles');
  const inverters = devices.filter(d => d.type === 'Power inverter');
  const rawPower = rows.map((row) => electricalKind(row) === 'activePower' ? Number(row.data) : NaN).find(Number.isFinite);
  const sourceInverters = rawInverterSignals(rows);
  const hasUnmappedPowerEvidence = !inverters.length && rawPower !== undefined;
  const statusLabel = (inverter: Device) => {
    if (inverter.sourceEvidence?.reportingState === 'saved') return 'Saved source';
    if (inverter.sourceEvidence?.scalingStatus === 'validated') return inverter.status === 'online' ? 'Validated live' : 'Validated stale';
    if (inverter.sourceEvidence) return inverter.status === 'online' ? 'Live source tag' : 'Stale source tag';
    return inverter.status;
  };
  const statusClass = (inverter: Device) => inverter.sourceEvidence?.scalingStatus === 'validated'
    ? inverter.status === 'online'
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
      : 'border-amber-500/20 bg-amber-500/10 text-amber-300'
    : inverter.sourceEvidence
      ? inverter.sourceEvidence.reportingState === 'saved'
        ? 'border-slate-600 bg-slate-800 text-slate-300'
        : inverter.status === 'online'
          ? 'border-blue-500/20 bg-blue-500/10 text-blue-300'
          : 'border-amber-500/20 bg-amber-500/10 text-amber-300'
      : inverter.status === 'online'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
        : inverter.status === 'offline'
          ? 'border-rose-500/20 bg-rose-500/10 text-rose-400'
          : 'border-amber-500/20 bg-amber-500/10 text-amber-400';
  const metricValue = (inverter: Device, paths: string[][], unit: string) => {
    const value = paths.map((path) => numberFrom(inverter, path, NaN)).find(Number.isFinite);
    return value === undefined ? 'Not reported' : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
  };
  const powerValue = (inverter: Device) => inverter.sourceEvidence?.signalKind === 'identity'
    ? `${inverter.sourceEvidence.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} raw`
    : inverter.sourceEvidence
    ? `${inverter.sourceEvidence.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${inverter.sourceEvidence.scalingStatus === 'validated' ? inverter.sourceEvidence.unit ?? 'kW' : 'raw'}`
    : metricValue(inverter, [['power', 'active_kw'], ['power', 'activePower']], 'kW');
  const powerLabel = (inverter: Device) => inverter.sourceEvidence?.signalKind === 'identity' ? 'Source identity reading' : 'Active power';
  const dailyEnergyValue = (inverter: Device) => metricValue(inverter, [['energy', 'daily_mwh']], 'MWh');
  const deviceFaults = (inverter: Device) => collectAlarmFaultEvidence(inverter.telemetry).faults;
  const deviceAlarms = (inverter: Device) => collectAlarmFaultEvidence(inverter.telemetry).alarms;
  const deviceIdentity = (inverter: Device) => inverter.sourceEvidence
    ? `${inverter.sourceEvidence.inverterId ? `${inverter.sourceEvidence.inverterId} · ` : ''}${inverter.sourceEvidence.sourceName ?? 'MQTT source'} · ${inverter.sourceEvidence.parameter} · ${inverter.sourceEvidence.address}`
    : inverter.id;
  const observedLabel = (inverter: Device) => {
    const observedAt = inverter.sourceEvidence?.observedAt ?? new Date(inverter.lastSeen).toISOString();
    return formatInPlantTimezone(observedAt, undefined);
  };
  return (
    <div className="scada-inverter-fleet scada-interactive-card self-start h-fit w-full min-w-0 rounded-xl border border-[#1E293B] bg-[#090B13] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-[#1E293B] pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Layers3 size={16} />
          </div>
          <div className="min-w-0"><h3 className="truncate text-sm font-bold tracking-wide text-slate-200 uppercase">Inverter fleet</h3><p className="mt-0.5 text-[10px] text-slate-500">Source-backed device status and reported output.</p></div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-indigo-300 min-[420px]:inline-flex">{inverters.length ? `${inverters.length} asset${inverters.length === 1 ? '' : 's'}` : 'No mapped assets'}</span>
          <div role="group" aria-label="Inverter fleet display mode" className="flex rounded-lg border border-[#1E293B] bg-[#0b0f19] p-1">
            <button type="button" onClick={() => setView('tiles')} aria-pressed={view === 'tiles'} data-testid="button-inverter-view-tiles" title="Show informative inverter tiles" className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide focus-ring ${view === 'tiles' ? 'bg-blue-500/15 text-blue-300' : 'text-slate-500 hover:text-slate-200'}`}><Grid2X2 size={13} />Tiles</button>
            <button type="button" onClick={() => setView('grid')} aria-pressed={view === 'grid'} data-testid="button-inverter-view-grid" title="Show informative inverter grid" className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide focus-ring ${view === 'grid' ? 'bg-blue-500/15 text-blue-300' : 'text-slate-500 hover:text-slate-200'}`}><LayoutGrid size={13} />Grid</button>
          </div>
          {onViewAll && <button type="button" onClick={onViewAll} data-testid="button-view-all-inverters" title="Open the inverter fleet" className="text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-slate-200 focus-ring rounded-md px-2 py-1 transition-colors bg-[#1E293B]/50 hover:bg-[#1E293B]">View All</button>}
        </div>
      </div>
      {inverters.length && view === 'tiles' && <div data-testid="inverter-fleet-tiles" className="scada-inverter-fleet-tiles grid gap-3">
        {inverters.map((inverter) => {
          const faults = deviceFaults(inverter);
          const alarms = deviceAlarms(inverter);
          const hasIssue = faults.length > 0 || alarms.length > 0;
          return <button key={inverter.id} type="button" data-testid={`card-inverter-${inverter.id}`} onClick={() => onOpenInverter(inverter)} className="group min-w-0 rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4 text-left transition hover:-translate-y-0.5 hover:border-blue-500/35 hover:bg-[#111827] focus-ring">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><h4 className="truncate text-sm font-bold text-slate-100 group-hover:text-blue-300">{inverter.name}</h4><p className="mt-1 truncate font-mono text-[10px] text-slate-500" title={deviceIdentity(inverter)}>{deviceIdentity(inverter)}</p></div>
              <span className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${statusClass(inverter)}`}>{statusLabel(inverter)}</span>
            </div>
              <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-lg border border-[#1E293B] bg-[#090B13]">
               <div className="min-w-0 border-r border-[#1E293B] px-3 py-2.5"><p className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Daily generation</p><p className="mt-1 break-words font-mono text-sm font-bold text-slate-200">{dailyEnergyValue(inverter)}</p></div>
               <div className="min-w-0 px-3 py-2.5"><p className="text-[9px] font-bold uppercase tracking-wide text-slate-500">{powerLabel(inverter)}</p><p className={`mt-1 break-words font-mono text-sm font-bold ${inverter.sourceEvidence?.scalingStatus === 'raw' ? 'text-amber-300' : 'text-slate-200'}`}>{powerValue(inverter)}</p></div>
            </div>
             <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px]">
              <span className={`rounded-full px-2 py-1 font-bold ${hasIssue ? 'bg-rose-500/10 text-rose-300' : 'bg-emerald-500/10 text-emerald-400'}`}>{hasIssue ? `${faults.length} fault${faults.length === 1 ? '' : 's'} · ${alarms.length} alarm${alarms.length === 1 ? '' : 's'}` : 'No reported faults'}</span>
              <span className="font-semibold text-slate-500 group-hover:text-blue-300">View details →</span>
            </div>
             <p className="mt-2 truncate text-[9px] text-slate-500" title={`Observed ${observedLabel(inverter)}`}>Observed {observedLabel(inverter)}</p>
          </button>;
        })}
      </div>}
      {inverters.length && view === 'grid' && <div data-testid="inverter-fleet-grid" className="max-w-full overflow-x-auto scrollbar-thin">
        <table className="min-w-[1040px] w-full text-left">
          <thead className="border-b border-[#1E293B] text-[9px] font-bold uppercase tracking-wider text-slate-500"><tr><th className="px-3 py-3">Inverter</th><th className="px-3 py-3">Reporting state</th><th className="px-3 py-3">Last observation</th><th className="px-3 py-3">Daily generation</th><th className="px-3 py-3">Active power / source reading</th><th className="px-3 py-3">Alarm / fault</th><th className="px-3 py-3 text-right">Details</th></tr></thead>
          <tbody className="divide-y divide-[#1E293B]/70">{inverters.map((inverter) => {
            const faults = deviceFaults(inverter);
            const alarms = deviceAlarms(inverter);
            const hasIssue = faults.length > 0 || alarms.length > 0;
            return <tr key={inverter.id} data-testid={`row-inverter-${inverter.id}`} role="button" tabIndex={0} aria-label={`Open details for ${inverter.name}`} onClick={() => onOpenInverter(inverter)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenInverter(inverter); } }} className="scada-table-row scada-inverter-row cursor-pointer hover:bg-[#1E293B]/40 focus-visible:bg-[#1E293B]/40 focus-visible:outline-none">
              <td className="px-3 py-3"><p className="font-semibold text-slate-200">{inverter.name}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{deviceIdentity(inverter)}</p></td>
              <td className="px-3 py-3"><span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${statusClass(inverter)}`}>{statusLabel(inverter)}</span></td>
              <td className="px-3 py-3 text-[10px] text-slate-400">{observedLabel(inverter)}</td>
              <td className="px-3 py-3 font-mono text-xs font-semibold text-slate-300">{dailyEnergyValue(inverter)}</td>
              <td className={`px-3 py-3 font-mono text-xs font-semibold ${inverter.sourceEvidence?.scalingStatus === 'raw' ? 'text-amber-300' : 'text-slate-300'}`}>{powerValue(inverter)}</td>
              <td className="px-3 py-3"><span className={`text-xs font-semibold ${hasIssue ? 'text-rose-300' : 'text-emerald-400'}`}>{hasIssue ? `${faults.length} fault${faults.length === 1 ? '' : 's'} · ${alarms.length} alarm${alarms.length === 1 ? '' : 's'}` : 'No reported faults'}</span></td>
              <td className="px-3 py-3 text-right text-xs font-semibold text-blue-300">Open →</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {!inverters.length && <div className="rounded-lg border border-dashed border-[#1E293B] px-4 py-8 text-center text-xs text-slate-500">{sourceInverters.length ? 'Source inverter tags are available but have not been mapped into device cards yet.' : hasUnmappedPowerEvidence ? `Unmapped active-power evidence: ${rawPower.toLocaleString()} raw` : 'No inverter source tags have been discovered yet.'}</div>}
      
      <div className="mt-1 flex items-center gap-3 border-t border-[#1E293B] pt-2.5 text-[10px] text-slate-400">
         <span className="uppercase tracking-wider font-semibold">Fleet summary</span>
          <span className="font-bold text-slate-200">{inverters.length ? inverters.some((inverter) => inverter.sourceEvidence?.scalingStatus === 'validated') ? `${inverters.filter((inverter) => inverter.sourceEvidence?.scalingStatus === 'validated').length} validated live record${inverters.filter((inverter) => inverter.sourceEvidence?.scalingStatus === 'validated').length === 1 ? '' : 's'}` : inverters.some((inverter) => inverter.sourceEvidence) ? `${inverters.length} source tag${inverters.length === 1 ? '' : 's'} · mapping required` : `${inverters.filter((inverter) => inverter.status === 'online').length} mapped reporting · device telemetry` : hasUnmappedPowerEvidence ? 'Unmapped source evidence' : 'Data unavailable'}</span>
      </div>
    </div>
  );
}

function EnergySummaryChart({ mode, dailyEnergy, rawFallback, savedLabel, liveState, streamSamples, now }: { mode: 'demo' | 'live'; dailyEnergy: VerifiedKpiCalculation; rawFallback?: RawKpiFallback; savedLabel?: string; liveState: 'fresh' | 'stale' | 'unavailable'; streamSamples: LiveEnergySample[]; now: number }) {
  const [range, setRange] = useState<keyof typeof energyDataByRange>('daily');
  const hasVerifiedValue = dailyEnergy.quality === 'verified';
  const hasRawValue = !hasVerifiedValue && rawFallback?.value !== null && rawFallback?.value !== undefined;
  const preferredSource = hasVerifiedValue ? dailyEnergy.inputs[0] : rawFallback?.inputs[0];
  const liveSeries = useMemo(
    () => selectLiveEnergySeries(streamSamples, preferredSource),
    [preferredSource?.address, preferredSource?.parameter, streamSamples],
  );
  const latestStreamSample = liveSeries.at(-1);
  const latestStreamSampleAge = latestStreamSample ? now - Date.parse(latestStreamSample.receivedAt) : Number.POSITIVE_INFINITY;
  const liveSeriesCurrent = mode === 'live'
    && liveState === 'fresh'
    && Number.isFinite(latestStreamSampleAge)
    && latestStreamSampleAge >= 0
    && latestStreamSampleAge <= DEVICE_ONLINE_MAX_AGE_MS;
  const hasLiveSeries = mode === 'live'
    && liveState !== 'unavailable'
    && latestStreamSample !== undefined
    && Number.isFinite(latestStreamSampleAge)
    && latestStreamSampleAge >= 0
    && latestStreamSampleAge <= DEVICE_STALE_MAX_AGE_MS;
  const data = mode === 'demo'
    ? energyDataByRange[range]
    : hasLiveSeries
      ? liveSeries.map((sample) => ({
        time: new Date(sample.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        value: sample.value,
        receivedAt: sample.receivedAt,
        sourceObservedAt: sample.sourceObservedAt,
      }))
      : [];
  const firstStreamSample = liveSeries[0];
  const hasDisplayValue = mode === 'demo' || hasVerifiedValue || hasRawValue || hasLiveSeries;
  const displayValue = mode === 'demo'
    ? range === 'daily' ? '14.13' : range === 'monthly' ? '96.1' : '3,862'
      : liveSeriesCurrent
        ? latestStreamSample!.value.toLocaleString(undefined, { maximumFractionDigits: 4 })
        : hasVerifiedValue
      ? dailyEnergy.value!.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : hasRawValue
        ? rawFallback!.value!.toLocaleString(undefined, { maximumFractionDigits: 4 })
        : hasLiveSeries
          ? latestStreamSample!.value.toLocaleString(undefined, { maximumFractionDigits: 4 })
          : 'Data unavailable';
  const displayUnit = mode === 'demo'
    ? range === 'yearly' ? 'MWh this year' : `MWh ${range === 'daily' ? 'today' : 'this month'}`
    : liveSeriesCurrent ? 'raw · live SSE' : hasVerifiedValue ? `${dailyEnergy.unit} · ${dailyEnergy.profileVersion}` : hasRawValue ? `raw${savedLabel ? ` · Last Saved: ${savedLabel}` : ''}` : hasLiveSeries ? 'raw · last live sample' : 'no verified daily counter';
  return (
    <div className="scada-chart-surface bg-[#090B13] border border-[#1E293B] rounded-xl p-6 flex flex-col h-full relative overflow-hidden group">
      <div className="flex items-center justify-between mb-6 border-b border-[#1E293B] pb-4 relative z-10">
        <div className="flex flex-col">
           <h3 className="text-sm font-bold tracking-wide text-slate-200 uppercase flex items-center gap-3 mb-1">
             <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
               <Activity size={16} />
             </div>
             Energy Summary
           </h3>
            <p className="text-[10px] text-slate-500 font-medium tracking-wide mt-1">{mode === 'demo' ? 'Demonstration trend' : hasLiveSeries ? `${liveSeriesCurrent ? 'Live SSE lane' : 'Last live energy samples'} · ${liveSeries.length} source sample${liveSeries.length === 1 ? '' : 's'} · ${latestStreamSample?.parameter} · ${latestStreamSample?.address}` : liveState !== 'fresh' ? 'Live energy lane paused while fresh source data is unavailable' : hasVerifiedValue ? `${dailyEnergy.provenance === 'snapshot' ? 'Saved-window' : 'Live'} verified daily counter · ${dailyEnergy.profileVersion}` : hasRawValue ? 'Source-backed raw daily-energy register' : 'Verified energy history unavailable'}</p>
        </div>
        <div role="tablist" aria-label="Energy time range" className="flex bg-[#0F1322] p-1 rounded-lg border border-[#1E293B] shadow-inner shrink-0">
           {(['daily', 'monthly', 'yearly'] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={range === option} onClick={() => setRange(option)} data-testid={`button-energy-range-${option}`} className={`px-3 py-1 text-[11px] rounded-md font-bold capitalize transition-all focus-ring ${range === option ? 'bg-[#2563EB] text-white shadow-md' : 'text-slate-500 hover:text-slate-300 hover:bg-[#1E293B]'}`}>{option}</button>)}
        </div>
      </div>
      <div className="mb-8 relative z-10">
         <span className={`text-4xl font-bold tracking-tighter mono ${hasDisplayValue ? 'text-slate-100' : 'text-slate-500'}`}>{displayValue}</span> <span className="text-[12px] font-bold text-slate-500 uppercase tracking-widest ml-2">{displayUnit}</span>
      </div>
      <div className="flex-1 min-h-[160px] relative z-10">
          {data.length ? <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
            <Tooltip cursor={{ fill: 'rgba(37, 99, 235, 0.15)' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${hasVerifiedValue ? dailyEnergy.unit ?? '' : 'raw'}`, 'Streamed daily counter']} labelFormatter={(label) => mode === 'live' ? `Received ${label}` : String(label)} />
            <Bar dataKey="value" fill="#2563EB" radius={[4, 4, 0, 0]} activeBar={{ fill: '#3B82F6', stroke: '#60A5FA', strokeWidth: 1 }} />
          </BarChart>
          </ResponsiveContainer> : hasRawValue ? (
            <div data-testid="panel-energy-raw-snapshot" className="flex h-full min-h-[140px] flex-col justify-center gap-4 rounded-lg border border-dashed border-blue-500/30 bg-blue-500/[0.03] px-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-blue-400">Raw source snapshot</p>
                  <p className="mt-1 text-[11px] text-slate-500">Historical energy series is not available for this view.</p>
                </div>
                <span className="font-mono text-sm font-bold text-blue-300">{displayValue} <span className="text-[10px] uppercase tracking-widest text-slate-500">{displayUnit}</span></span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-blue-500/10">
                <div className="h-full w-full rounded-full bg-blue-500/50" />
              </div>
              <div className="flex flex-wrap justify-between gap-2 text-[10px] text-slate-500">
                <span>Register {rawFallback?.inputs[0]?.address ?? '—'}</span>
                <span>Scaling required · current value only</span>
              </div>
            </div>
          ) : <div className="flex h-full min-h-[140px] items-center justify-center rounded-lg border border-dashed border-[#1E293B] text-center text-xs text-slate-500">{liveState !== 'fresh' && mode === 'live' ? <>Live lane paused<br /><span className="text-[10px]">Awaiting a fresh direct MQTT/SSE energy counter.</span></> : <>Data unavailable<br /><span className="text-[10px]">Awaiting a source-backed daily-energy counter.</span></>}</div>}
      </div>
      <div className="flex justify-between text-[10px] font-bold tracking-widest text-slate-500 mt-4 mono relative z-10">
        {hasLiveSeries ? <><span>{new Date(firstStreamSample!.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span className={liveSeriesCurrent ? 'text-blue-300' : 'text-amber-300'}>{liveSeriesCurrent ? 'LIVE SSE' : 'LAST LIVE'}</span><span>{new Date(latestStreamSample!.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></> : <><span>00</span><span>02</span><span>04</span><span>06</span><span>08</span><span>10</span><span>12</span><span>14</span><span>16</span><span>18</span><span>20</span><span>22</span></>}
      </div>
    </div>
  );
}

function CalculationSummaryPanel({ calculations, rawRows = [], className = '' }: { calculations: VerifiedScadaKpis; rawRows?: TelemetryKpiRow[]; className?: string }) {
  const entries = [calculations.acPower, calculations.dailyEnergy, calculations.totalEnergy, calculations.specificYield];
  const rawFallbacks = useMemo(() => rawKpiFallbacks(rawRows), [rawRows]);
  return (
    <section data-testid="panel-kpi-calculations" aria-label="Verified KPI calculations" className={`rounded-xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5 ${className}`}>
      <div className="flex flex-col gap-2 border-b border-[#1E293B] pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-300">Calculation evidence</p>
          <h2 className="mt-1 text-sm font-bold text-slate-100">Plant KPI calculations & source evidence</h2>
          <p className="mt-1 text-xs leading-5 text-slate-400">Cards always show the latest raw source evidence when it exists. Engineering units and converted KPI values appear only after an administrator-approved plant calibration profile matches the source register, scaling, unit, and counter role.</p>
        </div>
        <span className="shrink-0 rounded-md border border-[#1E293B] bg-[#0b0f19] px-2 py-1 text-[10px] font-semibold text-slate-400">Profile {entries[0].profileVersion}</span>
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {entries.map((calculation) => {
          const rawFallback = rawFallbacks[calculation.key];
          const verified = calculation.quality === 'verified';
          const displayValue = verified
            ? `${calculation.value!.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${calculation.unit}`
            : rawFallback.value === null
              ? 'Not reported'
              : `${rawFallback.value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${rawFallback.unit}`;
          const inputs = verified ? calculation.inputs : rawFallback.inputs;
          const formula = verified ? calculation.formula : rawFallback.formula;
          const method = verified ? calculation.method.replaceAll('-', ' ') : rawFallback.method;
          const readiness = verified ? calculation.readiness : rawFallback.readiness;
          return (
          <details key={calculation.key} className="rounded-lg border border-[#1E293B] bg-[#0b0f19]/60 p-3">
            <summary className="cursor-pointer list-none focus-ring rounded">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{calculation.label}</p>
                  <p className={`mt-1 text-sm font-bold ${verified ? 'text-emerald-400' : rawFallback.value === null ? 'text-slate-400' : 'text-amber-300'}`}>{displayValue}</p>
                </div>
                <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase ${verified ? 'bg-emerald-500/10 text-emerald-400' : rawFallback.value === null ? 'bg-slate-800 text-slate-400' : 'bg-amber-500/10 text-amber-300'}`}>{verified ? 'Verified' : rawFallback.value === null ? 'Not reported' : rawFallback.inputs.some((input) => input.sourceReported) ? 'Source reported' : 'Raw evidence'}</span>
              </div>
            </summary>
            <div className="mt-3 border-t border-[#1E293B] pt-3 text-[11px] leading-5 text-slate-400">
              <p><strong className="text-slate-300">Formula:</strong> {formula}</p>
              <p className="mt-1"><strong className="text-slate-300">Method:</strong> {method}</p>
              <p className="mt-1"><strong className="text-slate-300">Quality:</strong> {readiness}</p>
              {calculation.snapshotWindow && <p className="mt-1"><strong className="text-slate-300">Saved window:</strong> {new Date(calculation.snapshotWindow.startedAt).toLocaleString()} – {new Date(calculation.snapshotWindow.endedAt).toLocaleString()}</p>}
              {inputs.length > 0 && <div className="mt-2"><strong className="text-slate-300">Included evidence:</strong><ul className="mt-1 space-y-1">{inputs.map((source) => {
                const observedAt = verified ? (source as VerifiedKpiCalculation['inputs'][number]).observedAt : undefined;
                const unit = verified ? (source as VerifiedKpiCalculation['inputs'][number]).unit : (source as RawTelemetryMetric).sourceUnit ?? 'raw';
                return <li key={`${source.parameter}-${source.address}-${observedAt ?? 'raw'}`} className="rounded bg-[#090B13] px-2 py-1">{source.parameter} · {source.value.toLocaleString()} {unit} · register {source.address}{observedAt ? ` · ${new Date(observedAt).toLocaleString()}` : ''}</li>;
              })}</ul></div>}
              {calculation.excluded.length > 0 && <div className="mt-2"><strong className="text-amber-300">Excluded outliers:</strong><ul className="mt-1 space-y-1">{calculation.excluded.map((source) => <li key={`${source.parameter}-${source.address}-${source.observedAt}`} className="rounded bg-amber-500/5 px-2 py-1">{source.parameter} · {source.value.toLocaleString()} {source.unit} · register {source.address}</li>)}</ul></div>}
            </div>
          </details>
          );
        })}
      </div>
    </section>
  );
}

function WorkspaceHeader({ eyebrow, title, description, action, onBack }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 border-b border-[#1E293B] pb-6 sm:flex-row sm:items-end sm:justify-between relative">
      <span className="absolute bottom-0 left-0 w-1/3 h-px bg-gradient-to-r from-[#2563EB] to-transparent pointer-events-none" />
      <div className="min-w-0">
        <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-200 focus-ring transition-colors">← Back to overview</button>
        <p className="text-[11px] font-bold uppercase tracking-widest text-[#2563EB] text-glow mb-1">{eyebrow}</p>
        <h1 tabIndex={-1} data-testid="workspace-heading" className="text-3xl font-bold tracking-tight text-slate-100 focus:outline-none">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400 font-medium">{description}</p>
      </div>
      {action && <div className="shrink-0 mb-1">{action}</div>}
    </div>
  );
}

function MonitorWorkspace({ section, devices, rows, mode, liveState, persistence, calculations, savedSnapshot, validatedFleet, rawPayload, rawJson, rawTopic, rawPayloadSource, onCopy, onOpenInverter, onBack, onRefreshWeather, onSiteChange, siteName, sites, weather, now, energyStream, lastLiveDataTimestamp }: {
  section: string;
  devices: Device[];
  rows: ModbusRow[];
  mode: 'demo' | 'live';
  liveState: 'fresh' | 'stale' | 'unavailable';
  persistence: PersistenceStatus;
  calculations: VerifiedScadaKpis;
  savedSnapshot: SavedKpiSnapshot | null;
  validatedFleet: ValidatedInverterFleet;
  rawPayload: string;
  rawJson: JsonValue | null;
  rawTopic: string;
  rawPayloadSource: 'waiting' | 'demo' | 'replay' | 'retained' | 'recovered' | 'live';
  onCopy: (value: string) => void;
  onOpenInverter: (device: Device) => void;
  onBack: () => void;
  onRefreshWeather: () => void;
  onSiteChange: (site: string) => void;
  siteName: string;
  sites: string[];
  weather: WeatherState;
  now: number;
  energyStream: LiveEnergySample[];
  lastLiveDataTimestamp?: string;
}) {
  const commonAction = <span className={`rounded-lg border px-3 py-2 text-xs font-semibold ${liveState === 'fresh' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>{liveState === 'fresh' ? `Live · ${formatInPlantTimezone(lastLiveDataTimestamp, persistence.timezone)}` : mode === 'demo' ? 'Demo source' : `Live unavailable · last received ${formatInPlantTimezone(lastLiveDataTimestamp, persistence.timezone)}`}</span>;
  const savedSnapshotRows = (savedSnapshot?.parameters ?? []) as ModbusRow[];
  const usingSavedSnapshot = mode === 'live' && savedSnapshotRows.length > 0;
  const evidenceRows = usingSavedSnapshot ? savedSnapshotRows : rows;
  const workspaceRawFallbacks = rawKpiFallbacks(evidenceRows);
  const workspaceRawInverters = rawInverterSignals(evidenceRows);
  const workspaceRawInverterIdentities = rawInverterIdentitySignals(evidenceRows);
  const workspaceSavedLabel = usingSavedSnapshot && savedSnapshot
    ? formatInPlantTimezone(savedSnapshot.capturedAt, savedSnapshot.timezone)
    : undefined;
  if (section === 'inverters') return (
    <div data-testid="screen-inverters">
      <WorkspaceHeader eyebrow="Asset monitoring" title="Inverter fleet" description="Inspect the health, reporting state, and source-backed output of every inverter connected to this plant." action={commonAction} onBack={onBack} />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[
          ['Mapped assets', devices.filter((device) => device.type === 'Power inverter').length || '—', 'Explicitly identified inverter assets'],
          ['Mapped reporting', devices.filter((device) => device.type === 'Power inverter' && device.status === 'online').length || '—', 'Only validated device status is counted'],
          ['Saved rows', evidenceRows.length.toLocaleString(), usingSavedSnapshot ? 'Confirmed backend record only' : 'No confirmed saved record'],
        ].map(([label, value, detail]) => <div key={label} className="scada-interactive-card rounded-xl border border-[#1E293B] bg-[#090B13] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 text-xl font-bold text-slate-100">{value}</p><p className="mt-1 text-[10px] text-slate-500">{detail}</p></div>)}
      </div>
      {mode === 'live' && <div className="mb-5"><InverterHealthHeatmap fleet={validatedFleet} onOpenInverter={(record) => onOpenInverter(sourceBackedInverterDevice(record, siteName))} /></div>}
      <div className="w-full">
        <InverterOverviewTable devices={devices} rows={evidenceRows} onOpenInverter={onOpenInverter} />
      </div>
    </div>
  );
  if (section === 'live-data') return <div data-testid="screen-live-data"><WorkspaceHeader eyebrow="Telemetry operations" title="Live data explorer" description="Inspect only direct MQTT/SSE telemetry. Saved, replayed, retained, and queued evidence never appears in this view." action={commonAction} onBack={onBack} /><DetailedLiveDataTable rows={rows} persistence={persistence} lastReceivedAt={lastLiveDataTimestamp} /><div className="mt-5"><CompletePayloadInspector rawPayload={rawPayload} rawJson={rawJson} topic={rawTopic} source={rawPayloadSource} onCopy={onCopy} /></div></div>;
  if (section === 'energy') return <div data-testid="screen-energy"><WorkspaceHeader eyebrow="Energy analytics" title="Energy performance" description="Compare generation trends and plant output with clear separation between demonstration values and source-backed live telemetry." action={commonAction} onBack={onBack} /><CalculationSummaryPanel calculations={calculations} rawRows={evidenceRows} className="mb-5" /><div className="grid gap-5 xl:grid-cols-2"><EnergySummaryChart mode={mode} dailyEnergy={calculations.dailyEnergy} rawFallback={workspaceRawFallbacks.dailyEnergy} savedLabel={workspaceSavedLabel} liveState={liveState} streamSamples={energyStream} now={now} /><PowerTrendChart calculation={calculations.acPower} mode={mode} rawFallback={workspaceRawFallbacks.acPower} savedLabel={workspaceSavedLabel} /><div className="xl:col-span-2"><PowerDistributionChart inverters={mode === 'demo' ? devices.filter((device) => device.type === 'Power inverter') : []} rawInverters={workspaceRawInverters} rawInverterIdentities={workspaceRawInverterIdentities} validatedFleet={validatedFleet} mode={mode} savedLabel={workspaceSavedLabel} onOpenInverter={(record) => onOpenInverter(sourceBackedInverterDevice(record, siteName))} /></div></div></div>;
  if (section === 'environment') return <div data-testid="screen-environment"><WorkspaceHeader eyebrow="Site conditions" title="Environment" description="Review weather, irradiance, and site context using the verified coordinates configured for this plant." action={commonAction} onBack={onBack} /><EnvironmentDetails siteName={siteName} sites={sites} weather={weather} now={now} onRefresh={onRefreshWeather} onSiteChange={onSiteChange} /></div>;
  if (section === 'alarms') return <div data-testid="screen-alarms"><WorkspaceHeader eyebrow="Operations center" title="Alarms & events" description="Keep operational attention on source-reported alarms, faults, and data-quality exceptions that need review." action={<span className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300">Review required</span>} onBack={onBack} />{usingSavedSnapshot && <p role="status" className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-200">Saved backend alarm evidence · {workspaceSavedLabel}. Current alarm state requires direct live telemetry.</p>}<InverterFaultBoard devices={devices} rows={evidenceRows} onOpenInverter={onOpenInverter} /><div className="mt-5"><SidePanels devices={devices} rows={rows} liveState={liveState} savedRows={usingSavedSnapshot ? savedSnapshotRows : []} savedLabel={workspaceSavedLabel} /></div><div className="mt-5"><DetailedLiveDataTable rows={rows.filter((row) => isMappedAlarmOrFault(row) || /alarm|fault|error|warning/i.test(telemetrySourceParameter(row)))} persistence={persistence} lastReceivedAt={lastLiveDataTimestamp} /></div></div>;
  if (section === 'raw-data') return <Suspense fallback={<div role="status" className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-[#334155] bg-[#090B13] text-sm text-slate-400">Loading Report Center…</div>}><ReportCenter siteName={siteName} sites={sites} devices={devices} parameters={Array.from(new Set([...rows, ...savedSnapshotRows].map((row) => String(row.name ?? row.parameter ?? '').trim()).filter(Boolean))).sort()} /></Suspense>;
  return <div data-testid="screen-performance"><WorkspaceHeader eyebrow="Performance" title="Plant performance" description="Monitor output behavior and electrical source evidence together, with live and historical context kept clearly separated." action={commonAction} onBack={onBack} /><CalculationSummaryPanel calculations={calculations} rawRows={evidenceRows} className="mb-5" /><div className="grid gap-5 xl:grid-cols-2"><PowerTrendChart calculation={calculations.acPower} mode={mode} rawFallback={workspaceRawFallbacks.acPower} savedLabel={workspaceSavedLabel} /><ElectricalParametersChart rows={rows} mode={mode} liveState={liveState} savedSnapshot={savedSnapshot} siteName={siteName} /></div></div>;
}

function PowerTrendChart({ calculation, mode, rawFallback, savedLabel }: { calculation: VerifiedKpiCalculation; mode: 'demo' | 'live'; rawFallback?: RawKpiFallback; savedLabel?: string }) {
  const [range, setRange] = useState<keyof typeof powerTrendByRange>('today');
  const data = mode === 'demo' ? powerTrendByRange[range] : [];
  const hasVerifiedValue = calculation.quality === 'verified';
  const hasRawValue = !hasVerifiedValue && rawFallback?.value !== null && rawFallback?.value !== undefined;
  const displayValue = mode === 'demo'
    ? '—'
    : hasVerifiedValue
      ? calculation.value!.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : hasRawValue
        ? rawFallback!.value!.toLocaleString(undefined, { maximumFractionDigits: 4 })
        : 'Data unavailable';
  const displayUnit = mode === 'demo'
    ? 'demo trend below'
    : hasVerifiedValue ? `${calculation.unit} · ${calculation.provenance === 'snapshot' ? 'saved window' : 'right now'} · ${calculation.profileVersion}` : hasRawValue ? `raw${savedLabel ? ` · Last Saved: ${savedLabel}` : ''}` : 'no source-backed power';
  return (
    <div className="scada-chart-surface bg-[#090B13] border border-[#1E293B] rounded-xl p-6 flex flex-col h-full relative overflow-hidden group">
      <div className="flex items-center justify-between mb-6 border-b border-[#1E293B] pb-4 relative z-10">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400">
            <Activity size={16} />
          </div>
          <h3 className="text-sm font-bold tracking-wide text-slate-200 uppercase">Power Trend</h3>
        </div>
        <div role="tablist" aria-label="Power trend time range" className="flex items-center rounded-lg border border-[#1E293B] bg-[#0F1322] p-1 shadow-inner">
          {(['today', 'week', 'month'] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={range === option} onClick={() => setRange(option)} data-testid={`button-power-range-${option}`} className={`rounded-md px-3 py-1 text-[11px] font-bold capitalize transition-all focus-ring ${range === option ? 'bg-[#FF5C00] text-white shadow-md' : 'text-slate-500 hover:text-slate-300 hover:bg-[#1E293B]'}`}>{option}</button>)}
        </div>
      </div>
      <div className="mb-8 relative z-10">
         <span className={`text-4xl font-bold tracking-tighter mono ${mode === 'demo' || hasVerifiedValue || hasRawValue ? 'text-slate-100' : 'text-slate-500'}`}>{displayValue}</span> <span className="text-[12px] font-bold text-slate-500 uppercase tracking-widest ml-2">{displayUnit}</span>
      </div>
      <div className="flex-1 min-h-[160px] relative z-10">
         {data.length ? <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={powerTrendByRange[range]} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--scada-border)" vertical={false} opacity={0.5} />
            <XAxis dataKey="time" hide />
            <Tooltip cursor={{ stroke: '#FF5C00', strokeDasharray: '3 3', strokeWidth: 1.5 }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} kW`, 'Plant power']} labelFormatter={(label) => `${range === 'today' ? 'Time' : 'Period'}: ${label}`} />
            <Area type="monotone" dataKey="power" stroke="#FF5C00" strokeWidth={3} fill="#FF5C00" fillOpacity={0.16} activeDot={{ r: 6, stroke: '#090B13', strokeWidth: 3, fill: '#FF5C00' }} isAnimationActive={false} />
         </AreaChart>
          </ResponsiveContainer> : hasRawValue ? (
            <div data-testid="panel-power-raw-snapshot" className="flex h-full min-h-[140px] flex-col justify-center gap-4 rounded-lg border border-dashed border-orange-500/30 bg-orange-500/[0.03] px-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-orange-400">Raw source snapshot</p>
                  <p className="mt-1 text-[11px] text-slate-500">A persisted power series is not available for this view.</p>
                </div>
                <span className="font-mono text-sm font-bold text-orange-300">{displayValue} <span className="text-[10px] uppercase tracking-widest text-slate-500">{displayUnit}</span></span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-orange-500/10">
                <div className="h-full w-full rounded-full bg-orange-500/50" />
              </div>
              <div className="flex flex-wrap justify-between gap-2 text-[10px] text-slate-500">
                <span>Register {rawFallback?.inputs[0]?.address ?? '—'}</span>
                <span>Scaling required · current value only</span>
              </div>
            </div>
          ) : <div className="flex h-full min-h-[140px] items-center justify-center rounded-lg border border-dashed border-[#1E293B] text-center text-xs text-slate-500">Data unavailable<br /><span className="text-[10px]">A persisted power series is not available for this view.</span></div>}
      </div>
      <div className="flex justify-between text-[10px] font-bold text-slate-500 mt-4 mono tracking-widest relative z-10">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span className="text-[#FF5C00]">NOW</span>
        <span>24:00</span>
      </div>
    </div>
  );
}

function InverterHealthHeatmap({ fleet, onOpenInverter }: { fleet: ValidatedInverterFleet; onOpenInverter: (record: ValidatedInverterPowerRecord) => void }) {
  const exclusionReasons = [...new Set(fleet.excluded.map((item) => item.reason))];
  return (
    <section data-testid="panel-inverter-health-heatmap" className="scada-chart-surface rounded-xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5">
      <div className="flex flex-col gap-3 border-b border-[#1E293B] pb-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300">Validated fleet health</p>
          <h2 className="mt-1 text-sm font-bold text-slate-100">Fresh source-backed inverter reporting</h2>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">Tiles show only fresh records with declared identity, active-power semantics, engineering units, and approved scaling. No health score is inferred from raw output.</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${fleet.records.length ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 bg-slate-800 text-slate-400'}`}>{fleet.records.length} live validated</span>
      </div>
      {fleet.records.length ? <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {fleet.records.map((record) => <button key={record.inverterId} type="button" onClick={() => onOpenInverter(record)} data-testid={`button-inverter-health-${record.inverterId}`} title={`${record.inverterName}\n${record.value.toLocaleString()} ${record.unit} active power\nSource time: ${record.sourceTimestamp}\nSource: ${record.sourceName} · ${record.address}\nProvenance: Live\nData quality: Scaling validated`} className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-3 text-left transition-colors hover:border-emerald-400/60 hover:bg-emerald-500/15 focus-ring">
          <span className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-bold text-emerald-200">{record.inverterName}</span><span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 pulse-soft" /></span>
          <span className="mt-2 block font-mono text-sm font-bold text-slate-100">{record.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} {record.unit}</span>
          <span className="mt-1 block truncate text-[9px] text-emerald-100/70">{formatInPlantTimezone(record.sourceTimestamp, undefined)} · live validated</span>
        </button>)}
      </div> : <p className="mt-4 rounded-lg border border-dashed border-[#334155] bg-[#0b0f19] px-4 py-6 text-center text-xs leading-5 text-slate-500">No fresh validated inverter record is available for the health heatmap.</p>}
      <div className="mt-3 flex flex-wrap gap-2 text-[10px] leading-4 text-slate-500">
        <span className="rounded-md border border-[#1E293B] bg-[#0b0f19] px-2 py-1">{fleet.excluded.length} evidence record{fleet.excluded.length === 1 ? '' : 's'} excluded</span>
        {exclusionReasons.slice(0, 2).map((reason) => <span key={reason} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-amber-200/80">{reason}</span>)}
      </div>
    </section>
  );
}

function PowerDistributionChart({ inverters, rawInverters = [], rawInverterIdentities = [], validatedFleet, mode, savedLabel, onOpenInverter }: {
  inverters: Device[];
  rawInverters?: RawInverterSignal[];
  rawInverterIdentities?: RawInverterSignal[];
  validatedFleet?: ValidatedInverterFleet;
  mode: 'demo' | 'live';
  savedLabel?: string;
  onOpenInverter?: (record: ValidatedInverterPowerRecord) => void;
}) {
  const poweredInverters = mode === 'demo'
    ? inverters.filter((inverter) => inverter.status === 'online').map((inverter) => ({
      id: inverter.id,
      name: inverter.name.replace('Inverter ', 'INV'),
      power: numberFrom(inverter, ['power', 'active_kw'], 0),
      record: undefined,
    })).filter((inverter) => inverter.power > 0)
    : (validatedFleet?.records ?? []).map((record) => ({
      id: record.inverterId,
      name: record.inverterName,
      power: record.value,
      record,
    }));
  const totalPower = poweredInverters.reduce((sum, inverter) => sum + inverter.power, 0);
  const distributionData = totalPower > 0 ? poweredInverters.map((inverter) => ({
    ...inverter,
    value: inverter.power / totalPower * 100,
    rawPower: inverter.power,
    sourceTimestamp: inverter.record?.sourceTimestamp,
    sourceName: inverter.record?.sourceName,
    address: inverter.record?.address,
  })) : [];
  const rawDistributionData = distributionData.length || mode === 'demo'
    ? []
    : rawInverters
      .filter((metric) => Number.isFinite(metric.value) && metric.value > 0)
      .map((metric) => ({ ...metric, value: metric.value }))
      .sort((left, right) => right.value - left.value);
  const identityEvidenceData = distributionData.length || rawDistributionData.length || mode === 'demo'
    ? []
    : rawInverterIdentities.map((metric) => ({ ...metric, value: metric.value }))
      .sort((left, right) => (left.inverterId ?? left.parameter).localeCompare(right.inverterId ?? right.parameter));
  const rawTotalPower = rawDistributionData.reduce((sum, metric) => sum + metric.value, 0);
  return (
    <div className="scada-chart-surface bg-[#090B13] border border-[#1E293B] rounded-xl p-6 flex flex-col h-full relative overflow-hidden group">
      <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-center gap-3 mb-6 border-b border-[#1E293B] pb-4 relative z-10">
        <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
          <Activity size={16} />
        </div>
        <div><h3 className="text-sm font-bold tracking-wide text-slate-200 uppercase">Power Distribution</h3><p className="mt-1 text-[10px] text-slate-500">{mode === 'demo' ? 'Demonstration allocation' : distributionData.length ? 'Fresh validated active-power contribution' : rawDistributionData.length ? savedLabel ? `Last saved raw inverter tags · ${savedLabel} · scaling required` : 'Latest raw inverter tags · scaling required' : identityEvidenceData.length ? 'Inverter identity evidence available · power mapping required' : 'Fresh validated active-power contribution only'}</p></div>
      </div>
      
      <div className="flex-1 flex flex-col md:flex-row items-center gap-8 relative z-10">
        <div className="h-[200px] w-[200px] relative flex justify-center shrink-0">
          {distributionData.length ? <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={distributionData} innerRadius={70} outerRadius={95} paddingAngle={4} dataKey="value" stroke="none" cornerRadius={6}>
                {distributionData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} content={({ active, payload }) => {
                const entry = active ? payload?.[0]?.payload as typeof distributionData[number] | undefined : undefined;
                if (!entry) return null;
                return <div className="rounded-lg border border-[#334155] bg-[#0f1423] px-3 py-2 text-[11px] shadow-xl"><p className="font-bold text-slate-100">{entry.name}</p><p className="mt-1 font-mono text-emerald-300">{entry.rawPower.toLocaleString(undefined, { maximumFractionDigits: 2 })} kW · {entry.value.toFixed(1)}%</p>{entry.record && <><p className="mt-1 text-slate-400">Source: {entry.sourceName} · {entry.address}</p><p className="text-slate-400">Timestamp: {entry.sourceTimestamp}</p><p className="text-emerald-300">Live · scaling validated · active power</p></>}</div>;
              }} />
            </PieChart>
          </ResponsiveContainer> : rawDistributionData.length ? (
            <div data-testid="panel-inverter-raw-distribution" className="flex h-full w-full flex-col items-center justify-center rounded-full border-2 border-dashed border-amber-500/30 bg-amber-500/[0.03] px-5 text-center">
              <span className="font-mono text-2xl font-bold text-amber-300">{rawTotalPower.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span className="mt-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">raw total</span>
              <span className="mt-3 max-w-[130px] text-[10px] leading-4 text-slate-500">Source tags are visible below; contribution percentages require scaling validation.</span>
            </div>
          ) : identityEvidenceData.length ? (
            <div data-testid="panel-inverter-identity-evidence" className="flex h-full w-full flex-col items-center justify-center rounded-full border-2 border-dashed border-sky-500/30 bg-sky-500/[0.03] px-5 text-center">
              <span className="font-mono text-2xl font-bold text-sky-300">{identityEvidenceData.length}</span>
              <span className="mt-1 text-[9px] font-bold uppercase tracking-widest text-slate-500">inverters identified</span>
              <span className="mt-3 max-w-[145px] text-[10px] leading-4 text-slate-500">Source identity readings are available. Power percentages require an approved active-power mapping.</span>
            </div>
          ) : <div className="flex h-full w-full items-center justify-center rounded-full border-2 border-dashed border-[#1E293B] px-5 text-center text-xs leading-5 text-slate-500">{mode === 'demo' ? 'No demo inverter output' : 'Validated inverter contribution unavailable'}</div>}
          {distributionData.length > 0 && <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-3xl font-bold text-slate-100 mono tracking-tighter">{(totalPower / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              <span className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mt-1">MW Total</span>
          </div>}
        </div>
        
        <div className="flex-1 space-y-3 min-w-0 w-full max-h-[180px] overflow-y-auto scrollbar-thin pr-2">
          {distributionData.length ? distributionData.map((entry, i) => (
            <button key={entry.id} type="button" disabled={!entry.record || !onOpenInverter} onClick={() => entry.record && onOpenInverter?.(entry.record)} data-testid={entry.record ? `button-inverter-contribution-${entry.id}` : undefined} title={entry.record ? `${entry.name}\nSource time: ${entry.sourceTimestamp}\nSource: ${entry.sourceName} · ${entry.address}\nLive · scaling validated · active power` : undefined} className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-left text-[12px] group/item hover:bg-[#1e293b]/60 disabled:cursor-default disabled:hover:bg-transparent focus-ring">
              <div className="flex items-center gap-3 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0 shadow-[0_0_8px_currentColor]" style={{ backgroundColor: COLORS[i], color: COLORS[i] }} />
                <span className="text-slate-400 font-semibold truncate group-hover/item:text-slate-200 transition-colors tracking-wide">{entry.name}</span>
              </div>
               <span className="text-slate-300 font-bold mono shrink-0">{entry.value.toFixed(1)}%</span>
            </button>
             )) : rawDistributionData.length ? rawDistributionData.map((entry, i) => (
               <div key={`${entry.inverterId ?? entry.parameter}-${entry.sourceName}-${entry.address}`} data-testid={`row-raw-inverter-contribution-${entry.parameter}`} className="space-y-1.5 rounded-md px-1.5 py-1.5">
                 <div className="flex items-center justify-between gap-3 text-[11px]">
                   <div className="flex min-w-0 items-center gap-3">
                     <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                      <span className="truncate font-semibold text-slate-400">{entry.inverterId ?? entry.parameter}</span>
                   </div>
                   <span className="shrink-0 font-mono font-bold text-amber-300">{entry.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} raw</span>
                 </div>
                  <p className="truncate text-[9px] text-slate-500" title={`${entry.sourceName} · ${entry.parameter} · ${entry.address}${entry.observedAt ? ` · ${formatInPlantTimezone(entry.observedAt, undefined)}` : ''}`}>{entry.sourceName} · {entry.parameter} · {entry.address}{entry.observedAt ? ` · ${formatInPlantTimezone(entry.observedAt, undefined)}` : ''}</p>
                 <div className="h-1.5 overflow-hidden rounded-full bg-amber-500/10">
                   <div className="h-full rounded-full bg-amber-500/60" style={{ width: `${rawTotalPower > 0 ? entry.value / rawTotalPower * 100 : 0}%` }} />
                 </div>
               </div>
              )) : identityEvidenceData.length ? identityEvidenceData.map((entry, i) => (
                <div key={`${entry.inverterId ?? entry.parameter}-${entry.sourceName}-${entry.address}`} data-testid={`row-inverter-identity-evidence-${entry.inverterId ?? entry.parameter}`} className="space-y-1.5 rounded-md px-1.5 py-1.5">
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                      <span className="truncate font-semibold text-slate-400">{entry.inverterId ?? entry.parameter}</span>
                    </div>
                    <span className="shrink-0 font-mono font-bold text-sky-300">{entry.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} raw</span>
                  </div>
                  <p className="truncate text-[9px] text-slate-500" title={`${entry.sourceName} · ${entry.parameter} · ${entry.address}${entry.observedAt ? ` · ${formatInPlantTimezone(entry.observedAt, undefined)}` : ''}`}>{entry.sourceName} · {entry.parameter} · {entry.address}{entry.observedAt ? ` · ${formatInPlantTimezone(entry.observedAt, undefined)}` : ''}</p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-sky-500/10">
                    <div className="h-full rounded-full bg-sky-500/50" style={{ width: '100%' }} />
                  </div>
                </div>
              )) : <p className="text-[11px] leading-5 text-slate-500">{mode === 'demo' ? 'Demo inverter power will appear here.' : `Contribution is withheld until fresh inverter records declare identity, active-power semantics, engineering units, and scaling validation. ${validatedFleet?.excluded.length ? `${validatedFleet.excluded.length} raw, stale, saved, replayed, or incompletely mapped record${validatedFleet.excluded.length === 1 ? '' : 's'} remain excluded.` : rawInverters.length ? `${rawInverters.length} raw inverter tag${rawInverters.length === 1 ? '' : 's'} remain available in source evidence.` : 'No inverter tags are currently available.'}`}</p>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#1E293B]/50 pt-3 text-[10px] text-slate-500"><span>{mode === 'live' ? distributionData.length ? 'Legend: live source · kW · active power · scaling validated' : rawDistributionData.length ? 'Legend: raw source tags · scaling required' : identityEvidenceData.length ? 'Legend: source identity evidence · not power' : 'Legend: validated contribution unavailable' : 'Legend: demonstration values'}</span>{savedLabel && <span className="font-bold tracking-widest">{rawDistributionData.length ? `LAST SAVED SOURCE: ${savedLabel}` : `LAST SAVED EXCLUDED: ${savedLabel}`}</span>}</div>
    </div>
  );
}

function weatherMetricValue(value: number | string | null | undefined, unit = '', precision = 1) {
  if (value === null || value === undefined || value === '') return 'Data unavailable';
  if (typeof value === 'number') return `${value.toFixed(precision)}${unit ? ` ${unit}` : ''}`;
  return value;
}

function windDirection(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${directions[Math.round(value / 45) % directions.length]} ${Math.round(value)}°`;
}

function EnvironmentMetric({ icon: Icon, label, value, tone, detail }: { icon: typeof Thermometer; label: string; value: string; tone: string; detail: string }) {
  return (
    <div className="scada-interactive-card min-w-0 rounded-xl border border-[#1E293B] bg-[#090B13] p-4 flex flex-col justify-between" title={detail}>
      <div className="mb-4 flex items-center gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border bg-opacity-10 ${tone.includes('rose') ? 'bg-rose-500/10 border-rose-500/20 text-rose-500' : tone.includes('amber') ? 'bg-amber-500/10 border-amber-500/20 text-amber-500' : tone.includes('blue') ? 'bg-blue-500/10 border-blue-500/20 text-blue-500' : tone.includes('emerald') ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : 'bg-[#1E293B]/60 text-slate-400'}`}><Icon size={16} /></span>
        <span className="break-words text-[11px] font-bold uppercase tracking-widest text-slate-400">{label}</span>
      </div>
      <p className={`break-words text-2xl font-bold mono tracking-tighter ${value === 'Data unavailable' ? 'text-slate-500 text-sm' : 'text-slate-100'}`} title={value}>{value}</p>
      <p className="mt-2 pt-2 border-t border-[#1E293B]/50 break-words text-[10px] text-slate-500 font-bold uppercase tracking-widest">{detail}</p>
    </div>
  );
}

function EnvironmentDetails({ siteName, sites = [], weather, now, onRefresh, onSiteChange }: {
  siteName: string;
  sites: string[];
  weather: WeatherState;
  now: number;
  onRefresh: () => void;
  onSiteChange: (site: string) => void;
}) {
  const current = weather.data?.current;
  const resolvedLocation = weather.data?.location;
  const configuredCoordinates = weather.location;
  const isLoading = weather.status === 'loading';
  const locationLabel = resolvedLocation?.locationName ?? (configuredCoordinates ? 'Resolving configured coordinates…' : 'Location not configured');
  const observationAt = weather.data?.freshness.observationTime?.replace('T', ' ') ?? 'Data unavailable';
  const receivedAt = weather.data?.freshness.retrievedAt ? new Date(weather.data.freshness.retrievedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Data unavailable';
  const sourceLabel = weather.data ? `${weather.data.source} · ${resolvedLocation?.coordinateSource ?? 'Location data unavailable'}` : configuredCoordinates?.source ?? 'Location data unavailable';
  const siteOptions = sites.length ? sites : [siteName];
  const freshnessLabel = weather.data?.freshness.cacheStatus === 'cached' ? 'Cached response' : weather.data ? 'Fresh response' : 'Data unavailable';
  const weatherIcon = current?.weatherCondition?.toLowerCase().includes('rain') || current?.weatherCondition?.toLowerCase().includes('drizzle') ? CloudRain : current?.weatherCondition?.toLowerCase().includes('clear') ? Sun : CloudSun;
  const WeatherIcon = weatherIcon;
  const windDegrees = current?.windDirectionDeg;
  const percentWidth = (value: number | null | undefined) => value === null || value === undefined ? 0 : Math.max(0, Math.min(100, value));
  const metricDetail = (label: string) => `${label} · ${siteName} · observed ${observationAt} · source ${sourceLabel} · ${freshnessLabel}`;
  const temperatureTrend = weather.data?.temperatureTrend ?? [];
  const coordinateLatitude = resolvedLocation?.latitude ?? configuredCoordinates?.latitude;
  const coordinateLongitude = resolvedLocation?.longitude ?? configuredCoordinates?.longitude;
  const addressSummary = [resolvedLocation?.city, resolvedLocation?.district, resolvedLocation?.state, resolvedLocation?.country].filter((value): value is string => Boolean(value)).join(' · ') || 'Location data unavailable';
  const timezoneLabel = resolvedLocation?.timezone ?? 'Location data unavailable';
  const utcOffsetLabel = resolvedLocation?.utcOffset ?? 'Location data unavailable';
  const localDateTime = formatCurrentTimeInTimezone(now, resolvedLocation?.timezone);
  const locationUpdatedAt = configuredCoordinates?.updatedAt
    ? new Date(configuredCoordinates.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not available';

  return (
    <section id="environment" data-section="environment" className="scada-interactive-card scroll-mt-6 overflow-hidden rounded-xl border border-[#1E293B] bg-[#090B13]">
      <div className="border-b border-[#1E293B] bg-gradient-to-r from-orange-500/[0.08] via-transparent to-blue-500/[0.06] p-4 sm:p-5">
        <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-orange-500/20 bg-orange-500/10 text-orange-400"><CloudSun size={17} /></span>
              <h2 className="text-sm font-bold text-slate-100">Environment Details</h2>
              <span data-testid="status-weather" className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${weather.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400' : weather.status === 'stale' ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-500/10 text-amber-400'}`}><span className={`h-1.5 w-1.5 rounded-full ${weather.status === 'ready' ? 'bg-emerald-400 pulse-soft' : 'bg-amber-400'}`} />{weather.status === 'ready' ? 'Live weather' : weather.status === 'stale' ? 'Stale data' : isLoading ? 'Refreshing' : 'Data unavailable'}</span>
            </div>
              <div className="mt-3 flex flex-col items-start gap-2 text-xs text-slate-400 sm:flex-row sm:items-center">
               <label className="flex w-full min-w-0 items-center gap-2 sm:w-auto"><MapPin size={13} className="shrink-0 text-orange-400" /><span className="shrink-0 font-semibold text-slate-500">Plant/site</span><select value={siteName} onChange={(event) => onSiteChange(event.target.value)} data-testid="select-environment-site" className="min-w-0 flex-1 rounded-md border border-[#1E293B] bg-[#0b0f19] px-2 py-1.5 text-xs font-semibold text-slate-200 focus-ring sm:w-[210px] sm:flex-none">{siteOptions.map((site) => <option key={site} value={site}>{site}</option>)}</select></label>
               <span className="hidden h-4 w-px bg-[#1e293b] sm:block" />
                  <span className="max-w-full break-words" title={locationLabel}><LocateFixed size={13} className="mr-1 inline text-slate-500" />{locationLabel}</span>
            </div>
          </div>
           <div className="grid w-full min-w-0 grid-cols-1 gap-2 text-[10px] min-[520px]:grid-cols-2 xl:grid-cols-3 2xl:w-auto">
              <span data-testid="weather-location-source" className="min-w-0 break-words rounded-lg border border-[#1E293B] bg-[#0b0f19] px-2.5 py-1.5 text-slate-400" title={`Configured site/device weather provenance: ${sourceLabel}`}>Location source: {sourceLabel}</span>
             <span className="min-w-0 break-words rounded-lg border border-[#1E293B] bg-[#0b0f19] px-2.5 py-1.5 text-slate-400" title={`Weather provider observation timestamp: ${observationAt}`}>Observed: {observationAt}</span>
              <span data-testid="weather-location-updated" className="min-w-0 break-words rounded-lg border border-[#1E293B] bg-[#0b0f19] px-2.5 py-1.5 text-slate-400" title="Last time the configured plant coordinates were saved">Location updated: {locationUpdatedAt}</span>
             <span className={`min-w-0 break-words rounded-lg border border-[#1E293B] px-2.5 py-1.5 ${weather.data?.freshness.cacheStatus === 'cached' ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'}`} title="Data freshness state">{freshnessLabel}</span>
            <button type="button" onClick={onRefresh} data-testid="button-refresh-weather" title="Refresh weather for the selected configured site" className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#1E293B] px-2.5 py-1.5 font-semibold text-slate-300 hover:bg-[#1e293b] focus-ring"><RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} /> Refresh</button>
          </div>
        </div>
      </div>
      {weather.status === 'unavailable' && <div role="status" data-testid="status-weather-unavailable" className="mx-4 mt-4 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-3 text-xs text-amber-300 sm:mx-5"><AlertCircle size={15} className="mt-0.5 shrink-0" /><div><p className="font-semibold">Weather data unavailable for this site</p><p className="mt-1 text-amber-200/70">{weather.message ?? 'No verified configured plant location is available.'}</p></div></div>}

      <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="grid gap-3 sm:grid-cols-2">
             <div className="rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4 sm:col-span-2">
               <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Configured coordinate identity</p><p className="mt-1 text-base font-bold text-slate-100">{locationLabel}</p><p className="mt-1 text-xs text-slate-400">Plant/site: {siteName} · Coordinate source: {configuredCoordinates?.source ?? 'Location data unavailable'}</p><p className="mt-1 text-[10px] text-slate-500">Last updated: {locationUpdatedAt}</p></div><MapPin size={18} className="text-orange-400" /></div>
            <div className="mt-4 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div className="rounded-lg bg-[#090B13] p-2.5"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Latitude</span><span data-testid="weather-location-latitude" className="mt-1 block font-mono font-semibold text-slate-200">{coordinateLatitude === undefined ? 'Location data unavailable' : coordinateLatitude.toFixed(6)}</span></div>
              <div className="rounded-lg bg-[#090B13] p-2.5"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Longitude</span><span data-testid="weather-location-longitude" className="mt-1 block font-mono font-semibold text-slate-200">{coordinateLongitude === undefined ? 'Location data unavailable' : coordinateLongitude.toFixed(6)}</span></div>
              <div className="rounded-lg bg-[#090B13] p-2.5 sm:col-span-2"><span className="block text-[9px] uppercase tracking-wider text-slate-500">City / District / State / Country</span><span data-testid="weather-location-address" className="mt-1 block font-semibold text-slate-200">{addressSummary}</span></div>
              <div className="rounded-lg bg-[#090B13] p-2.5"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Weather timezone</span><span data-testid="weather-location-timezone" className="mt-1 block font-mono font-semibold text-slate-200">{timezoneLabel}</span></div>
              <div className="rounded-lg bg-[#090B13] p-2.5"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Timezone UTC offset</span><span data-testid="weather-location-offset" className="mt-1 block font-mono font-semibold text-slate-200">{utcOffsetLabel}</span></div>
              <div className="rounded-lg bg-[#090B13] p-2.5 sm:col-span-2"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Current local date &amp; time</span><span data-testid="weather-location-local-time" className="mt-1 block font-mono font-semibold text-slate-200">{localDateTime}</span></div>
            </div>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-blue-500/15 bg-blue-500/5 px-3 py-2 text-[10px] text-blue-200/80"><LocateFixed size={13} className="text-blue-400" /> Weather, address, timezone, and environmental analytics use only these configured coordinates.</div>
          </div>
          <div className="rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Live condition</p><p className="mt-2 text-lg font-bold text-slate-100">{current?.weatherCondition ?? 'Data unavailable'}</p></div><span className="grid h-11 w-11 place-items-center rounded-full border border-orange-500/20 bg-orange-500/10 text-orange-300"><WeatherIcon size={24} /></span></div><p className="mt-3 text-[10px] text-slate-500">{metricDetail('Weather condition')}</p></div>
          <div className="rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Wind compass</p><p className="mt-2 text-lg font-bold text-slate-100">{weatherMetricValue(current?.windSpeedMs, 'm/s')}</p></div><div className="relative grid h-12 w-12 place-items-center rounded-full border border-[#334155] bg-[#090B13] text-[8px] text-slate-500"><span className="absolute top-1">N</span><span className="absolute bottom-1">S</span><span className="absolute left-1">W</span><span className="absolute right-1">E</span><span className="h-0.5 w-7 origin-center bg-blue-400" style={{ transform: `rotate(${windDegrees ?? 0}deg)` }} /><span className="absolute h-2 w-2 rounded-full bg-blue-400" /></div></div><p className="mt-3 text-[10px] text-slate-500">{windDirection(windDegrees) ?? 'Direction unavailable'} · {metricDetail('Wind')}</p></div>
        </div>

        <div className="rounded-xl border border-[#1E293B] bg-[#0b0f19] p-4">
          <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Temperature trend</p><p className="mt-1 text-xs text-slate-400">Provider observations in {weather.data?.location.timezone ?? 'site timezone'}</p></div><Thermometer size={17} className="text-rose-400" /></div>
          {temperatureTrend.length > 1 ? <div className="mt-3 h-40"><ResponsiveContainer width="100%" height="100%"><AreaChart data={temperatureTrend} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}><CartesianGrid strokeDasharray="2 4" stroke="var(--scada-border)" vertical={false} /><XAxis dataKey="time" tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} tickFormatter={(value) => String(value).slice(11, 16)} /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} tickFormatter={(value) => `${value}°`} width={32} /><Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toFixed(1)} °C`, 'Temperature']} /><Area type="monotone" dataKey="temperatureC" stroke="#fb7185" strokeWidth={2} fill="#fb7185" fillOpacity={0.16} isAnimationActive={false} /></AreaChart></ResponsiveContainer></div> : <div className="mt-3 flex h-40 items-center justify-center rounded-lg border border-dashed border-[#1E293B] text-center text-xs text-slate-500">Data unavailable<br /><span className="text-[10px]">No provider temperature trend returned.</span></div>}
          <p className="mt-2 text-[10px] text-slate-500">{metricDetail('Temperature trend')} · Last updated {receivedAt}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-[#1E293B] p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">
        <EnvironmentMetric icon={Thermometer} label="Temperature" value={weatherMetricValue(current?.temperatureC, '°C')} tone="text-rose-400" detail={metricDetail('Temperature')} />
        <EnvironmentMetric icon={Wind} label="Wind speed" value={weatherMetricValue(current?.windSpeedMs, 'm/s')} tone="text-blue-400" detail={metricDetail('Wind speed')} />
        <EnvironmentMetric icon={LocateFixed} label="Wind direction" value={windDirection(current?.windDirectionDeg) ?? 'Data unavailable'} tone="text-indigo-400" detail={metricDetail('Wind direction')} />
        <EnvironmentMetric icon={Droplets} label="Humidity" value={weatherMetricValue(current?.humidityPct, '%', 0)} tone="text-cyan-400" detail={metricDetail('Humidity')} />
        <EnvironmentMetric icon={Sun} label="Solar irradiance" value={current?.irradianceWm2 === null || current?.irradianceWm2 === undefined ? 'Not reported by provider' : weatherMetricValue(current.irradianceWm2, 'W/m²', 0)} tone="text-orange-400" detail={metricDetail('Solar irradiance')} />
        <EnvironmentMetric icon={CloudSun} label="Cloud cover" value={weatherMetricValue(current?.cloudCoverPct, '%', 0)} tone="text-slate-400" detail={metricDetail('Cloud cover')} />
        <EnvironmentMetric icon={CloudRain} label="Precipitation" value={weatherMetricValue(current?.precipitationMm, 'mm')} tone="text-sky-400" detail={metricDetail('Precipitation')} />
        <EnvironmentMetric icon={MapPin} label="Weather timezone" value={timezoneLabel} tone="text-emerald-400" detail={metricDetail('Weather timezone')} />
      </div>
      {current && <div className="grid gap-3 border-t border-[#1E293B] bg-[#0f1423] p-4 sm:grid-cols-3 sm:p-5"><div><div className="mb-1 flex justify-between text-[10px]"><span className="font-semibold text-slate-400">Humidity indicator</span><span className="font-mono text-slate-300">{weatherMetricValue(current.humidityPct, '%', 0)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#1e293b]"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${percentWidth(current.humidityPct)}%` }} /></div></div><div><div className="mb-1 flex justify-between text-[10px]"><span className="font-semibold text-slate-400">Cloud cover</span><span className="font-mono text-slate-300">{weatherMetricValue(current.cloudCoverPct, '%', 0)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#1e293b]"><div className="h-full rounded-full bg-slate-400" style={{ width: `${percentWidth(current.cloudCoverPct)}%` }} /></div></div><div><div className="mb-1 flex justify-between text-[10px]"><span className="font-semibold text-slate-400">Precipitation</span><span className="font-mono text-slate-300">{weatherMetricValue(current.precipitationMm, 'mm')}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#1e293b]"><div className="h-full rounded-full bg-sky-400" style={{ width: `${percentWidth(current.precipitationMm === null ? null : Math.min(100, current.precipitationMm * 10))}%` }} /></div></div></div>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1E293B] px-4 py-3 text-[10px] text-slate-500 sm:px-5"><span>Weather data source: <strong className="font-semibold text-slate-300">{weather.data?.source ?? 'Data unavailable'}</strong></span><span>Last updated: <strong className="font-semibold text-slate-300">{receivedAt}</strong></span><span>Site: <strong className="font-semibold text-slate-300">{siteName}</strong></span></div>
    </section>
  );
}

function SidePanels({ devices, rows, liveState, savedRows = [], savedLabel, onOpenAlarms }: { devices: Device[]; rows: ModbusRow[]; liveState: 'fresh' | 'stale' | 'unavailable'; savedRows?: ModbusRow[]; savedLabel?: string; onOpenAlarms?: () => void }) {
  const hasFreshTelemetry = liveState === 'fresh';
  const showingSavedData = !hasFreshTelemetry && savedRows.length > 0;
  const evidenceRows = hasFreshTelemetry ? rows : savedRows;
  const hasUsableEvidence = hasFreshTelemetry || showingSavedData;
  const unavailableLabel = showingSavedData ? 'Last saved' : liveState === 'stale' ? 'Telemetry stale' : 'Data unavailable';
  const reports = uniqueAlarmFaultReports([
    ...(hasFreshTelemetry ? deviceAlarmFaultReports(devices) : []),
    ...rowAlarmFaultReports(evidenceRows),
  ]);
  const alarmReports = reports.filter((report) => report.kind === 'Alarm');
  const faultReports = reports.filter((report) => report.kind === 'Fault');
  const explicitAlarmFaultSource = hasFreshTelemetry && devices.some(hasExplicitAlarmFaultField);
  const hasAlarmFaultEvidence = reports.length > 0 || explicitAlarmFaultSource;
  const latestFaultCode = faultReports.find((report) => report.fault.code)?.fault.code ?? 'Not reported';
  const latestAlarmCode = alarmReports.find((report) => report.fault.code)?.fault.code ?? 'Not reported';
  const qualityCounts = evidenceRows.reduce<{ good: number; scaling: number; bad: number; unreported: number }>((counts, row) => {
    const quality = String(row.quality ?? row.data_quality ?? '').toLowerCase();
    if (quality.includes('bad') || quality.includes('error') || quality.includes('fault')) counts.bad += 1;
    else if (quality.includes('good') || quality.includes('ok') || quality.includes('valid') || explicitScalingValidated(row)) counts.good += 1;
    else if (!explicitScalingValidated(row) && electricalKind(row)) counts.scaling += 1;
    else counts.unreported += 1;
    return counts;
  }, { good: 0, scaling: 0, bad: 0, unreported: 0 });
  const qualityTotal = qualityCounts.good + qualityCounts.scaling + qualityCounts.bad;
  const qualityObserved = qualityTotal + qualityCounts.unreported;
  const qualityPercent = hasUsableEvidence && qualityObserved ? Math.round((qualityCounts.good / qualityObserved) * 100) : null;
  return (
    <div className="flex h-fit flex-col gap-3 self-start">
      <div className="scada-interactive-card bg-[#090B13] border border-[#1E293B] rounded-xl p-3.5">
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className={reports.length ? 'text-rose-400' : 'text-slate-400'} />
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Alarms & Faults</h3>
          </div>
          {onOpenAlarms && <button type="button" onClick={onOpenAlarms} className="shrink-0 rounded-md px-1.5 py-1 text-[9px] font-bold uppercase tracking-wide text-blue-300 hover:bg-blue-500/10 focus-ring">Review all</button>}
        </div>
          <div className="space-y-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Alarm evidence</span>
              <span className="font-bold text-slate-200">{hasAlarmFaultEvidence ? alarmReports.length : unavailableLabel}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Fault evidence</span>
              <span className="font-bold text-slate-200">{hasAlarmFaultEvidence ? faultReports.length : unavailableLabel}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Fault Code</span>
              <span className="max-w-[55%] truncate font-mono font-bold text-slate-300" title={latestFaultCode}>{hasAlarmFaultEvidence ? latestFaultCode : unavailableLabel}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Alarm Code</span>
              <span className="max-w-[55%] truncate font-mono font-bold text-slate-300" title={latestAlarmCode}>{hasAlarmFaultEvidence ? latestAlarmCode : unavailableLabel}</span>
          </div>
              <p className="pt-1 text-[9px] text-slate-500">{showingSavedData ? `Saved alarm and fault registers: ${savedLabel ?? 'timestamp unavailable'}.` : !hasFreshTelemetry ? 'Cached alarm evidence remains traceable in Live Data until a fresh payload arrives.' : hasAlarmFaultEvidence ? `${reports.length} source-reported alarm or fault register${reports.length === 1 ? '' : 's'} available for review. Codes remain unmodified.` : 'No alarm or fault fields were reported by the connected source.'}</p>
        </div>
      </div>
      
      <div className="scada-interactive-card bg-[#090B13] border border-[#1E293B] rounded-xl p-3.5">
        <div className="mb-2.5 flex items-center gap-2">
          <Check size={14} className="text-slate-400" />
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Data Quality</h3>
        </div>
         <div className="flex items-center gap-3">
           <div className="relative w-[52px] h-[52px] flex items-center justify-center">
             <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#1e293b" strokeWidth="3.5" />
                 {qualityPercent !== null && <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#10b981" strokeWidth="3.5" strokeDasharray={`${qualityPercent}, 100`} />}
             </svg>
             <span className={`absolute text-[10px] font-bold ${qualityPercent === null ? 'text-slate-500' : 'text-emerald-400'}`}>{qualityPercent === null ? '—' : `${qualityPercent}%`}</span>
           </div>
           <div className="space-y-2 flex-1">
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /><span className="text-slate-400">Good</span></div>
                 <span className="text-slate-200 font-bold">{hasUsableEvidence ? qualityCounts.good || '—' : '—'}</span>
             </div>
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /><span className="text-slate-400">Scaling</span></div>
                 <span className="text-slate-200 font-bold">{hasUsableEvidence ? qualityCounts.scaling || '—' : '—'}</span>
             </div>
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" /><span className="text-slate-400">Bad</span></div>
                 <span className="text-slate-200 font-bold">{hasUsableEvidence ? qualityCounts.bad || '—' : '—'}</span>
             </div>
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-slate-500" /><span className="text-slate-400">Unreported</span></div>
                <span className="text-slate-200 font-bold">{hasUsableEvidence ? qualityCounts.unreported || '—' : '—'}</span>
             </div>
           </div>
        </div>
           <p className="mt-2.5 text-[9px] text-slate-500">{showingSavedData ? `Last Saved Data: ${savedLabel ?? 'timestamp unavailable'}. ${qualityObserved ? `${qualityCounts.good} of ${qualityObserved} saved parameters are source-confirmed good.` : 'No quality metadata was reported in the saved record.'}` : !hasFreshTelemetry ? 'Cached quality evidence remains traceable in Live Data until a fresh payload arrives.' : qualityObserved ? `${qualityCounts.good} of ${qualityObserved} observed parameter${qualityObserved === 1 ? '' : 's'} are source-confirmed good${qualityCounts.unreported ? ` · ${qualityCounts.unreported} unreported` : ''}.` : 'Data unavailable until telemetry parameters arrive.'}</p>
      </div>
    </div>
  );
}

function InverterFaultBoard({ devices, rows = [], onOpenInverter }: { devices: Device[]; rows?: ModbusRow[]; onOpenInverter: (device: Device) => void }) {
  const reports = uniqueAlarmFaultReports([
    ...deviceAlarmFaultReports(devices),
    ...rowAlarmFaultReports(rows),
  ]);
  return <section data-testid="panel-inverter-faults" className="scada-interactive-card rounded-xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1E293B] pb-4">
      <div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-rose-300">Alarm & fault monitor</p><h2 className="mt-1 text-sm font-bold text-slate-100">Source-reported alarms and fault registers</h2><p className="mt-1 text-xs leading-5 text-slate-400">Expand an item to review its raw evidence, source, timestamp, any reported reason, and scoped operator checks.</p></div>
      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${reports.length ? 'bg-rose-500/10 text-rose-300' : 'bg-emerald-500/10 text-emerald-400'}`}>{reports.length ? `${reports.length} reported` : 'No reports'}</span>
    </div>
    {reports.length ? <div className="mt-4 grid gap-3 lg:grid-cols-2">{reports.map(({ device, kind, fault }) => {
      const model = device ? telemetryText(device.telemetry, ['model', 'deviceModel', 'device_model', 'modelName']) ?? undefined : undefined;
      const guidance = getFaultGuidance(fault, model);
      const mappingLabel = guidance.mapping === 'source-reported' ? 'Source reason' : guidance.mapping === 'reference-mapped' ? 'Reference mapping' : 'Reason not mapped';
      return <details key={`${device?.id ?? 'source'}-${kind}-${fault.id}`} className="group rounded-xl border border-rose-500/20 bg-rose-500/[0.04]">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-3.5 py-3 marker:content-none focus-ring">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-300">{kind}</span><span className="text-[10px] font-semibold text-slate-400">{device?.name ?? 'Source register'}</span></div><p className="mt-2 truncate text-xs font-bold text-slate-100">{guidance.title}</p><p className="mt-1 truncate font-mono text-[10px] text-slate-500">{fault.code ? `Code ${fault.code}` : 'Code not reported'} · {fault.source}</p></div>
          <span className="shrink-0 text-[10px] font-semibold text-rose-300 group-open:hidden">Review</span><span className="hidden shrink-0 text-[10px] font-semibold text-rose-300 group-open:inline">Close</span>
        </summary>
        <div className="border-t border-rose-500/15 px-3.5 py-3 text-xs leading-5 text-slate-300">
          <div className="grid gap-2 sm:grid-cols-2"><div><p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Fault reason</p><p className="mt-1">{guidance.reason}</p></div><div><p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Observed</p><p className="mt-1">{fault.observedAt ?? 'Not reported'}</p></div></div>
          <div className="mt-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] px-3 py-2"><p className="text-[9px] font-bold uppercase tracking-wider text-amber-300">{mappingLabel}</p><p className="mt-1 text-[10px] leading-4 text-amber-100/70">{guidance.scope}</p></div>
          <ol className="mt-3 list-decimal space-y-1 pl-4 text-[11px] leading-5">{guidance.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ol>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-rose-500/15 pt-3"><span className="max-w-full break-all font-mono text-[10px] text-slate-500" title={fault.rawValue}>Evidence: {fault.rawValue}</span>{device ? <button type="button" onClick={() => onOpenInverter(device)} className="shrink-0 rounded-md border border-blue-500/25 bg-blue-500/10 px-2.5 py-1.5 text-[10px] font-bold text-blue-300 hover:bg-blue-500/15 focus-ring">Open {device.name}</button> : <span className="shrink-0 rounded-md border border-[#1E293B] bg-[#0b0f19] px-2.5 py-1.5 text-[10px] font-semibold text-slate-400">Raw source evidence</span>}</div>
        </div>
      </details>;
    })}</div> : <div className="mt-4 rounded-lg border border-dashed border-[#1E293B] px-4 py-8 text-center text-xs leading-5 text-slate-500">No source-reported alarm or fault fields are available for this view.<br /><span className="text-[10px]">When the broker publishes an alarm, fault, warning, or error register, its unmodified evidence appears here.</span></div>}
  </section>;
}

function SavedBackendDataPanel({ snapshot, persistence }: { snapshot: SavedKpiSnapshot | null; persistence: PersistenceStatus }) {
  const rows = (snapshot?.parameters ?? []) as ModbusRow[];
  const savedAt = snapshot
    ? formatInPlantTimezone(snapshot.capturedAt, snapshot.timezone ?? persistence.timezone)
    : 'Not available';
  return (
    <section data-testid="panel-saved-backend-record" className="mt-6 overflow-hidden rounded-xl border border-[#1E293B] bg-[#090B13]">
      <div className="flex flex-col gap-3 border-b border-[#1E293B] p-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2"><Database size={16} className="text-blue-300" /><h3 className="text-sm font-bold text-slate-200">Saved Data</h3></div>
          <p className="mt-1 text-xs text-slate-500">Latest successfully saved backend record only. Queued, incomplete, missing, and direct live telemetry are excluded.</p>
        </div>
        <span data-testid="saved-data-record-timestamp" className="rounded border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-blue-200">Saved · {savedAt}</span>
      </div>
      {snapshot ? <div className="p-4">
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500"><span><strong className="text-slate-300">Captured:</strong> {formatInPlantTimezone(snapshot.capturedAt, snapshot.timezone ?? persistence.timezone)}</span><span><strong className="text-slate-300">Window:</strong> {formatInPlantTimezone(snapshot.windowStartedAt, snapshot.timezone ?? persistence.timezone)} – {formatInPlantTimezone(snapshot.windowEndedAt, snapshot.timezone ?? persistence.timezone)}</span><span><strong className="text-slate-300">Parameters:</strong> {snapshot.parameterCount}</span></div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{rows.slice(0, 8).map((row, index) => <div key={`${modbusRowKey(row)}-${index}`} className="rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-2"><p className="truncate text-[10px] font-semibold text-slate-400" title={telemetryDisplayLabel(row)}>{telemetryDisplayLabel(row)}</p><p className="mt-1 truncate font-mono text-xs text-slate-200">{formatValue(sourceReportedValue(row) ?? sourceTransportValue(row) ?? row.data ?? '—')}</p><p className="mt-1 truncate text-[10px] text-slate-500">{telemetryUnit(row)} · {telemetryDateTime(row).full}</p></div>)}</div>
        {rows.length > 8 && <p className="mt-3 text-[10px] text-slate-500">Showing 8 of {rows.length} saved source parameters. Electrical analysis retains the complete saved record.</p>}
      </div> : <div className="px-5 py-8 text-center text-xs text-slate-500">No successfully saved backend record is available for this site yet. Direct MQTT remains available only in Live Data.</div>}
    </section>
  );
}

function DetailedLiveDataTable({ rows, persistence, lastReceivedAt }: { rows: ModbusRow[]; persistence: PersistenceStatus; lastReceivedAt?: string }) {
  const [filter, setFilter] = useState('');
  const [filterCategory, setFilterCategory] = useState('All categories');
  const [filterSource, setFilterSource] = useState('All sources');
  const [sortKey, setSortKey] = useState<TelemetrySortKey>('parameter');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [exportMessage, setExportMessage] = useState('');
  const categories = useMemo(() => ["All categories", ...Array.from(new Set(rows.map(telemetryCategory))).sort()], [rows]);
  const sources = useMemo(() => ['All sources', ...Array.from(new Set(rows.map((row) => String(row.server_name || 'Modbus'))).values()).sort()], [rows]);
  const filteredRows = useMemo(() => rows.filter((row) => {
    const dateTime = telemetryDateTime(row);
       const searchable = `${telemetryDisplayLabel(row)} ${telemetrySourceParameter(row)} ${row.full_addr ?? row.addr ?? ''} ${row.server_name ?? ''} ${sourceReportedValue(row) ?? ''} ${sourceTransportValue(row) ?? ''} ${dateTime.date} ${dateTime.time}`.toLowerCase();
    return searchable.includes(filter.toLowerCase()) &&
      (filterCategory === 'All categories' || telemetryCategory(row) === filterCategory) &&
      (filterSource === 'All sources' || String(row.server_name || 'Modbus') === filterSource);
  }), [rows, filter, filterCategory, filterSource]);
  const sortedRows = useMemo(() => [...filteredRows].sort((a, b) => {
    const dateA = telemetryDateTime(a);
    const dateB = telemetryDateTime(b);
    const values: Record<TelemetrySortKey, (row: ModbusRow) => string | number> = {
      category: telemetryCategory,
      parameter: telemetryDisplayLabel,
       raw: (row) => String(sourceTransportValue(row) ?? ''),
       scaled: (row) => String(sourceReportedValue(row) ?? ''),
      unit: telemetryUnit,
      address: (row) => String(row.full_addr ?? row.addr ?? ''),
      date: (row) => telemetryDateTime(row).date,
      time: (row) => telemetryDateTime(row).time,
      source: (row) => String(row.server_name || 'Modbus'),
    };
    const left = values[sortKey](a);
    const right = values[sortKey](b);
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
    return sortDirection === 'asc' ? result : -result;
  }), [filteredRows, sortKey, sortDirection]);
  const handleSort = (nextKey: TelemetrySortKey) => {
    if (nextKey === sortKey) setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(nextKey);
      setSortDirection('asc');
    }
  };
  const sortLabel = `${sortKey} ${sortDirection === 'asc' ? 'ascending' : 'descending'}`;
  const scheduleLabel = `${persistence.scheduleStart ?? '06:00'}–${persistence.scheduleEnd ?? '18:00'} ${persistence.timezone ?? 'plant time'}`;
  const historicalSavingResumeMessage = persistenceResumeMessage(persistence.savingActive);
  const historicalStorageStatus = persistence.error
    ? historicalSavingResumeMessage
      ? 'Historical sync queued · resumes 6 AM'
      : 'Historical storage retrying'
    : persistence.savingActive
      ? `Historical saving · every ${persistence.intervalMinutes} min`
      : 'Historical saving paused';
  const lastSnapshotLabel = persistence.lastSnapshotAt
    ? `${persistence.lastSnapshotStatus === 'missing' ? 'Missing window' : 'Saved'} · ${formatInPlantTimezone(persistence.lastSnapshotScheduledFor ?? persistence.lastSnapshotAt, persistence.timezone)}`
    : 'No scheduled snapshot recorded yet';
  const lastReceivedLabel = lastReceivedAt
    ? formatInPlantTimezone(lastReceivedAt, persistence.timezone)
    : 'No direct live telemetry received';
  const resetFilters = () => {
    setFilter('');
    setFilterCategory('All categories');
    setFilterSource('All sources');
  };
  const exportExcel = () => {
    const title = `TRN246 Solar Plant — Detailed Live Data (${new Date().toLocaleString()})`;
     const columns = ['Category', 'Parameter', 'Transport Raw Value', 'Customer Value', 'Unit', 'Register Address', 'Data Quality', 'Source', 'Date', 'Time'];
    const cell = (value: unknown) => `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
    const reportRows = [
      `<Row>${cell(title)}</Row>`,
      `<Row>${cell(`Filter: ${filter || 'All parameters'} | Category: ${filterCategory} | Source: ${filterSource} | Sort: ${sortLabel} | Rows: ${sortedRows.length}`)}</Row>`,
      `<Row>${columns.map(cell).join('')}</Row>`,
      ...sortedRows.map((row) => {
        const dateTime = telemetryDateTime(row);
        return `<Row>${[
           telemetryCategory(row), telemetryDisplayLabel(row), sourceTransportValue(row), sourceReportedValue(row), telemetryUnit(row),
          row.full_addr ?? row.addr ?? '—', row.quality ?? 'Good', row.server_name || 'Modbus', dateTime.date, dateTime.time,
        ].map(cell).join('')}</Row>`;
      }),
    ];
    const workbook = `<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Live Telemetry"><Table>${reportRows.join('')}</Table></Worksheet></Workbook>`;
    exportBlob(new Blob([workbook], { type: 'application/vnd.ms-excel;charset=utf-8' }), `trn246-live-telemetry-${new Date().toISOString().slice(0, 10)}.xls`);
    setExportMessage(`Excel export prepared with ${sortedRows.length} filtered row${sortedRows.length === 1 ? '' : 's'}.`);
  };
  const exportPdf = () => {
    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
      setExportMessage('PDF preview was blocked. Allow pop-ups for this dashboard and try again.');
      return;
    }
    const title = 'TRN246 Solar Plant — Detailed Live Telemetry';
    const htmlRows = sortedRows.map((row) => {
      const dateTime = telemetryDateTime(row);
        return `<tr><td>${escapeHtml(telemetryCategory(row))}</td><td>${escapeHtml(telemetryDisplayLabel(row))}</td><td>${escapeHtml(sourceTransportValue(row))}</td><td>${escapeHtml(sourceReportedValue(row))}</td><td>${escapeHtml(telemetryUnit(row))}</td><td>${escapeHtml(row.full_addr ?? row.addr ?? '—')}</td><td>${escapeHtml(row.quality ?? row.source_mapping_status ?? 'Good')}</td><td>${escapeHtml(row.server_name || 'Modbus')}</td><td>${escapeHtml(dateTime.date)}</td><td>${escapeHtml(dateTime.time)}</td></tr>`;
    }).join('');
    reportWindow.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>
      @page{size:landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#172033;font-size:10px}h1{font-size:18px;margin:0 0 4px}p{margin:3px 0;color:#5c6b80}.meta{border-bottom:2px solid #dbe3ef;padding-bottom:10px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#e8eef7;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em}th,td{border:1px solid #dbe3ef;padding:6px 5px;vertical-align:top}td:nth-child(3),td:nth-child(4),td:nth-child(6),td:nth-child(10){font-family:monospace} .empty{text-align:center;padding:24px;color:#5c6b80}@media print{thead{display:table-header-group}tr{break-inside:avoid}}
    </style></head><body><div class="meta"><h1>${escapeHtml(title)}</h1><p>Generated: ${escapeHtml(new Date().toLocaleString())}</p><p>Filter: ${escapeHtml(filter || 'All parameters')} · Category: ${escapeHtml(filterCategory)} · Source: ${escapeHtml(filterSource)} · Sort: ${escapeHtml(sortLabel)} · Rows: ${sortedRows.length}</p></div><table><thead><tr>${['Category', 'Parameter', 'Raw Value', 'Customer Value', 'Unit', 'Register Address', 'Data Quality', 'Source', 'Date', 'Time'].map((heading) => `<th>${heading}</th>`).join('')}</tr></thead><tbody>${htmlRows || '<tr><td class="empty" colspan="10">No telemetry rows match the current filters.</td></tr>'}</tbody></table></body></html>`);
    reportWindow.document.close();
    reportWindow.focus();
    window.setTimeout(() => reportWindow.print(), 250);
    setExportMessage(`PDF report opened with ${sortedRows.length} filtered row${sortedRows.length === 1 ? '' : 's'}. Use the print dialog to save it as PDF.`);
  };
  const sortButton = (key: TelemetrySortKey, label: string) => <button type="button" onClick={() => handleSort(key)} aria-label={`Sort by ${label}; currently ${key === sortKey ? sortLabel : 'not sorted'}`} aria-sort={key === sortKey ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} data-testid={`button-sort-${key}`} className="inline-flex items-center gap-1 rounded px-1 py-1 text-left hover:bg-[#1e293b]/60 hover:text-slate-300 focus-ring">{label}<span aria-hidden="true" className={key === sortKey ? 'text-blue-400' : 'text-slate-600'}>{key === sortKey ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span></button>;
  
  return (
    <section id="live-data" data-section="live-data" className="bg-[#090B13] border border-[#1E293B] rounded-xl overflow-hidden flex flex-col mt-6">
      <div className="flex flex-col justify-between gap-4 border-b border-[#1E293B] p-5 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Database size={16} className="text-slate-400" />
            <h3 className="text-sm font-bold text-slate-200">Detailed Live Data</h3>
          </div>
          <p className="text-xs text-slate-500">Direct MQTT/SSE telemetry only. Saved, replayed, retained, and queued evidence is excluded from this view.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span data-testid="status-live-telemetry" className="rounded bg-sky-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-sky-300">Live · last received {lastReceivedLabel}</span>
          <span className={`rounded px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider ${persistence.error ? 'bg-rose-500/10 text-rose-400' : 'bg-[#1e293b] text-slate-300'}`}>
            {historicalStorageStatus}
          </span>
          <button type="button" onClick={exportExcel} data-testid="button-export-excel" title="Download the filtered and sorted telemetry as an Excel workbook" className="inline-flex items-center gap-1.5 rounded border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 focus-ring"><Download size={13} /> Excel</button>
          <button type="button" onClick={exportPdf} data-testid="button-export-pdf" title="Open a detailed filtered telemetry report ready to save as PDF" className="inline-flex items-center gap-1.5 rounded border border-rose-500/25 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 focus-ring"><FileText size={13} /> PDF</button>
        </div>
      </div>
      <div data-testid="status-historical-persistence" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#1E293B] bg-[#0b0f19] px-5 py-2 text-[10px] text-slate-500">
        <span><strong className="font-semibold text-slate-300">Saved historical data:</strong> {scheduleLabel}</span>
        <span><strong className="font-semibold text-slate-300">Next window:</strong> {formatInPlantTimezone(persistence.nextScheduledAt, persistence.timezone)}</span>
        <span><strong className="font-semibold text-slate-300">Last record:</strong> {lastSnapshotLabel}</span>
      </div>
       <div className="flex flex-col items-stretch gap-2 border-b border-[#1E293B] bg-[#0f1423] p-4 sm:flex-row sm:flex-wrap sm:items-center">
         <label className="relative w-full min-w-0 flex-1 sm:min-w-[220px] sm:flex-none">
          <span className="sr-only">Search live Modbus data</span>
          <Search size={14} aria-hidden="true" className="absolute left-3 top-2.5 text-slate-500" />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="input-filter-live-data" placeholder="Search parameter, address, source, date..." className="w-full rounded-lg border border-[#1E293B] bg-[#0b0f19] py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-500 focus-ring" />
        </label>
        <label>
          <span className="sr-only">Filter by telemetry category</span>
           <select value={filterCategory} onChange={(event) => setFilterCategory(event.target.value)} data-testid="select-filter-category" className="w-full rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-2 text-xs text-slate-300 focus-ring sm:w-auto">
            {categories.map((category) => <option key={category}>{category}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by telemetry source</span>
           <select value={filterSource} onChange={(event) => setFilterSource(event.target.value)} data-testid="select-filter-source" className="w-full max-w-full rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-2 text-xs text-slate-300 focus-ring sm:w-auto sm:max-w-[180px]">
            {sources.map((source) => <option key={source}>{source}</option>)}
          </select>
        </label>
        {(filter || filterCategory !== 'All categories' || filterSource !== 'All sources') && <button type="button" onClick={resetFilters} data-testid="button-clear-live-filters" className="rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 focus-ring">Clear filters</button>}
         <span role="status" data-testid="text-live-data-count" className="text-xs text-slate-400 sm:ml-auto">{sortedRows.length} of {rows.length} parameters</span>
      </div>
      {exportMessage && <div role="status" data-testid="status-export-message" className="border-b border-[#1E293B] bg-blue-500/5 px-5 py-2.5 text-xs text-blue-300">{exportMessage}</div>}
      
       <div className="max-w-full overflow-x-auto scrollbar-thin" data-scroll-region="live-telemetry-table">
         <div className="border-b border-[#1E293B] bg-[#0f1423] px-4 py-2 text-[10px] text-slate-500 sm:hidden">Swipe horizontally to inspect every telemetry field. No source columns are removed.</div>
         <table className="w-full min-w-[1260px] text-left whitespace-nowrap">
          <thead className="bg-[#0b0f19]">
            <tr>
              {[
                 ['category', 'Category'], ['parameter', 'Parameter'], ['raw', 'Transport Raw Value'], ['scaled', 'Customer Value'],
                 ['unit', 'Unit'], ['address', 'Register Address'], ['date', 'Date'], ['time', 'Time'], ['source', 'Source'],
              ].map(([key, label]) => <th key={key} className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">{sortButton(key as TelemetrySortKey, label)}</th>)}
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Data Quality</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1e293b]">
            {sortedRows.length ? sortedRows.map((row, index) => {
               const rawValue = formatValue(sourceTransportValue(row) ?? '');
               const scaledValue = formatValue(sourceReportedValue(row) ?? '');
               const dateTime = telemetryDateTime(row);
               const displayLabel = telemetryDisplayLabel(row);
               const sourceParameter = telemetrySourceParameter(row);
               const destination = mappedTelemetryDestination(row);
               return (
                    <tr key={`${modbusRowKey(row)}-${index}`} data-testid={`row-live-data-${index}`} title={`${displayLabel}\nSource parameter: ${sourceParameter}\nCustomer value: ${scaledValue} ${telemetryUnit(row)}\nTransport raw value: ${rawValue}\nModbus address: ${String(row.full_addr || row.addr || '—')}\nSource: ${String(row.server_name || 'Modbus')}\nQuality: ${String(row.quality || row.source_mapping_status || 'Good')}\nDate: ${dateTime.date}\nTime: ${dateTime.time}`} className="hover:bg-[#1e293b]/40 transition-colors">
                   <td className="px-5 py-2.5 text-[11px] text-slate-300 flex items-center gap-2">
                     <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                       <span>{telemetryCategory(row)}</span>{destination && <span className="rounded border border-blue-500/20 bg-blue-500/10 px-1 py-0.5 font-mono text-[8px] text-blue-300">{destination}</span>}
                   </td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-300 font-medium"><div>{displayLabel}</div>{displayLabel !== sourceParameter && <div className="mt-0.5 font-mono text-[9px] font-normal text-slate-500">Source: {sourceParameter}</div>}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{rawValue}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-200 font-mono font-bold">{scaledValue}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400">{telemetryUnit(row)}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{String(row.full_addr || row.addr || '—')}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400">{dateTime.date}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{dateTime.time}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400">{String(row.server_name || 'Modbus')}</td>
                   <td className="px-5 py-2.5">
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${explicitScalingValidated(row) ? 'bg-emerald-500/10 text-emerald-400' : hasSourceReportedValue(row) ? 'bg-blue-500/10 text-blue-300' : 'bg-amber-500/10 text-amber-400'}`}>
                         <span className="w-1 h-1 rounded-full bg-current" /> {explicitScalingValidated(row) ? 'Validated' : hasSourceReportedValue(row) ? 'Source-reported · scaling required' : String(row.quality || 'Raw / scaling required')}
                     </span>
                   </td>
                 </tr>
               );
             }) : (
                 <tr><td colSpan={10} className="px-5 py-10 text-center text-sm text-slate-400">{rows.length ? 'No parameters match the current filters.' : 'No live telemetry yet. The table will populate when the MQTT broker sends a Modbus parameter.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CompletePayloadInspector({ rawPayload, rawJson, topic, source, onCopy }: { rawPayload: string; rawJson: JsonValue | null; topic: string; source: 'waiting' | 'demo' | 'replay' | 'retained' | 'recovered' | 'live'; onCopy: (value: string) => void }) {
  const rows = rawJson ? flattenJson(rawJson) : [];
  const sourceLabel = source === 'replay' ? 'Initial replay evidence' : source === 'retained' ? 'Retained broker evidence' : source === 'recovered' ? 'Recovered delivery evidence' : source === 'demo' ? 'Demo payload' : source === 'live' ? 'Live payload' : 'Awaiting payload';
  const sourceTone = source === 'live' || source === 'recovered' ? 'success' : source === 'demo' || source === 'replay' || source === 'retained' ? 'warning' : 'neutral';
  return (
    <section id="raw-data" data-section="raw-data" className="scada-interactive-card bg-[#090B13] border border-[#1E293B] rounded-xl overflow-hidden mt-6">
      <div className="flex flex-col justify-between gap-3 border-b border-[#1E293B] p-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-1">
             <Code2 size={16} className="text-slate-400" />
             <h3 className="text-sm font-bold text-slate-200">Raw MQTT Payload</h3>
             <CustomBadge tone={sourceTone}><span className="w-1.5 h-1.5 rounded-full bg-current" />{sourceLabel}</CustomBadge>
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-1">{topic}</p>
        </div>
        <button type="button" onClick={() => onCopy(rawPayload)} data-testid="button-copy-raw-payload" title="Copy the exact MQTT message without formatting changes" className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e293b] text-[11px] font-medium text-slate-200 hover:bg-slate-700 transition-colors border border-[#334155] focus-ring">
          <Copy size={13} /> Copy Exact Message
        </button>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-[#1e293b]">
        <div className="p-5 flex flex-col max-h-[400px]">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-3">Exact JSON Message</p>
          <div className="flex-1 overflow-auto bg-[#0b0f19] rounded-lg border border-[#1E293B] p-3 scrollbar-thin">
             <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed">{rawPayload}</pre>
          </div>
        </div>
        <div className="p-5 flex flex-col max-h-[400px]">
          <div className="flex items-center justify-between mb-3">
             <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Discovered Fields</p>
             <span className="text-[9px] font-medium text-slate-400 bg-[#1e293b] px-2 py-0.5 rounded">{rows.length} fields</span>
          </div>
          <div className="flex-1 overflow-auto border border-[#1E293B] rounded-lg scrollbar-thin">
             <table className="w-full text-left">
               <thead className="bg-[#0b0f19] sticky top-0 border-b border-[#1E293B]">
                 <tr>
                   <th className="px-3 py-2 text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Path</th>
                   <th className="px-3 py-2 text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Value</th>
                 </tr>
               </thead>
               <tbody className="divide-y divide-[#1e293b]/50">
                 {rows.map((row, i) => (
                     <tr key={i} className="scada-table-row hover:bg-[#1e293b]/30">
                      <td className="break-all px-3 py-2 text-[11px] text-blue-400 font-mono">{row.path}</td>
                      <td className="max-w-[240px] break-all px-3 py-2 text-[11px] text-slate-300 font-mono">{row.value}</td>
                   </tr>
                 ))}
                 {!rows.length && <tr><td colSpan={2} className="px-3 py-8 text-center text-xs text-slate-500">Waiting for data...</td></tr>}
               </tbody>
             </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function emptyCalibrationSources(): PlantCalibrationSource[] {
  return [
    { role: 'acPower', sourceName: '', parameter: '', address: '', unit: 'kW', multiplier: 1, counterRole: 'instantaneous-power', scalingConfirmed: true },
    { role: 'dailyEnergy', sourceName: '', parameter: '', address: '', unit: 'kWh', multiplier: 1, counterRole: 'daily-counter', scalingConfirmed: true },
    { role: 'totalEnergy', sourceName: '', parameter: '', address: '', unit: 'kWh', multiplier: 1, counterRole: 'cumulative-counter', scalingConfirmed: true },
  ];
}

function CalibrationProfileEditor({ siteName, profile, canManage, onSave, onPreview }: {
  siteName: string;
  profile: PlantCalibrationProfile | null;
  canManage: boolean;
  onSave: (siteName: string, installedDcCapacityKwp: number | null, sources: PlantCalibrationSource[]) => Promise<void>;
  onPreview: (siteName: string, sources: PlantCalibrationSource[]) => Promise<CalibrationPreviewResponse>;
}) {
  const [capacity, setCapacity] = useState('');
  const [sources, setSources] = useState<PlantCalibrationSource[]>(emptyCalibrationSources);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<CalibrationPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    setCapacity(profile?.installedDcCapacityKwp ? String(profile.installedDcCapacityKwp) : '');
    setSources(profile?.sources.length ? profile.sources : emptyCalibrationSources());
    setError('');
    setSaved('');
    setPreview(null);
  }, [profile, siteName]);
  useEffect(() => { setPreview(null); }, [capacity]);
  const updateSource = (index: number, patch: Partial<PlantCalibrationSource>) => {
    setSources((current) => current.map((source, sourceIndex) => sourceIndex === index ? { ...source, ...patch } : source));
    setPreview(null);
  };
  const addSource = () => {
    setSources((current) => [...current, { role: 'acPower', sourceName: '', parameter: '', address: '', unit: 'kW', multiplier: 1, counterRole: 'instantaneous-power', scalingConfirmed: true }]);
    setPreview(null);
  };
  const removeSource = (index: number) => {
    setSources((current) => current.length > 1 ? current.filter((_, sourceIndex) => sourceIndex !== index) : current);
    setPreview(null);
  };
  const verify = async () => {
    if (!canManage) return;
    setError('');
    setSaved('');
    setPreviewing(true);
    try {
      setPreview(await onPreview(siteName, sources));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Unable to verify the draft mappings against broker evidence.');
    } finally {
      setPreviewing(false);
    }
  };
  const save = async () => {
    const installedDcCapacityKwp = capacity.trim() ? Number(capacity) : null;
    if (installedDcCapacityKwp !== null && (!Number.isFinite(installedDcCapacityKwp) || installedDcCapacityKwp <= 0)) {
      setError('Installed DC capacity must be a positive value in kWp when supplied.');
      return;
    }
    if (!sources.length) {
      setError('Add at least one confirmed source-register mapping.');
      return;
    }
    if (sources.some((source) => !source.sourceName.trim() || !source.parameter.trim() || !source.address.trim() || !Number.isFinite(source.multiplier) || source.multiplier <= 0)) {
      setError('Each source mapping needs a source name, parameter, register address, and positive scaling multiplier.');
      return;
    }
    if (!preview) {
      setError('Verify every draft mapping against current live broker evidence before approving this profile.');
      return;
    }
    if (preview.mappings.length !== sources.length || preview.mappings.some((mapping) => mapping.status !== 'matched')) {
      setError('Approval is held until every source mapping has a current live broker match. Refresh verification after resolving the flagged mapping(s).');
      return;
    }
    setError('');
    setSaved('');
    setSaving(true);
    try {
      await onSave(siteName, installedDcCapacityKwp, sources);
      setSaved('Approved plant calibration saved. Fresh readings now use this profile.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this plant calibration profile.');
    } finally {
      setSaving(false);
    }
  };
  const roleLabel: Record<PlantCalibrationSource['role'], string> = { acPower: 'Total AC Power', dailyEnergy: 'Today’s Energy', totalEnergy: 'Total Energy' };
  const roleCounter: Record<PlantCalibrationSource['role'], PlantCalibrationSource['counterRole']> = { acPower: 'instantaneous-power', dailyEnergy: 'daily-counter', totalEnergy: 'cumulative-counter' };
  return (
    <div className="space-y-4 border-t border-[#1E293B] pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold text-slate-300">Approved plant calibration</h3>
          <p className="mt-1 text-[10px] leading-5 text-slate-500">Match the raw source name, parameter, and register exactly. The multiplier converts the raw register to the declared engineering unit.</p>
        </div>
        <Gauge size={16} className="shrink-0 text-emerald-400" />
      </div>
      <div data-testid="plant-calibration-access" className={`rounded-lg border px-3 py-2.5 text-[11px] leading-5 ${canManage ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300' : 'border-slate-500/20 bg-slate-500/5 text-slate-400'}`}>
        {canManage ? `You can approve engineering units and source scaling for ${siteName}.` : 'View-only access. An authorized Platform/Site Administrator must approve source mappings before live engineering KPIs are shown.'}
      </div>
      {profile ? <div data-testid="plant-calibration-summary" className="rounded-lg border border-blue-500/20 bg-blue-500/[0.04] px-3 py-2 text-[10px] leading-5 text-slate-400"><span className="font-semibold text-blue-300">Active profile:</span> {profile.version} · approved {new Date(profile.approvedAt).toLocaleString()} · {profile.installedDcCapacityKwp ? `${profile.installedDcCapacityKwp.toLocaleString()} kWp` : 'installed capacity not approved'}</div> : <div data-testid="plant-calibration-missing" className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/[0.03] px-3 py-2 text-[10px] leading-5 text-amber-300">No approved profile for this plant. Dashboard cards will retain raw evidence and withhold kW, kWh, and specific-yield KPIs.</div>}
      <label className="block">
        <span className="mb-2 block text-xs font-bold text-slate-300">Installed DC capacity (kWp) <span className="font-normal text-slate-500">optional</span></span>
        <input inputMode="decimal" aria-label="Installed DC capacity in kWp" data-testid="input-calibration-capacity" value={capacity} onChange={(event) => setCapacity(event.target.value)} disabled={!canManage} placeholder="e.g. 50" className="w-full rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-3 font-mono text-xs text-slate-200 focus:border-blue-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60" />
        <p className="mt-1 text-[10px] leading-5 text-slate-500">Required only for Specific Yield. Individual power or energy source approvals can be saved without it.</p>
      </label>
      <div className="space-y-3">
        {sources.map((source, index) => <div key={`${source.role}-${index}`} className="rounded-lg border border-[#1E293B] bg-[#0b0f19]/60 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <select aria-label={`Calibration role ${index + 1}`} value={source.role} disabled={!canManage} onChange={(event) => {
              const role = event.target.value as PlantCalibrationSource['role'];
              updateSource(index, { role, counterRole: roleCounter[role], unit: role === 'acPower' ? 'kW' : 'kWh' });
            }} className="min-w-0 rounded-md border border-[#1E293B] bg-[#090B13] px-2 py-1.5 text-[10px] font-bold text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60">
              {Object.entries(roleLabel).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
            </select>
            {canManage && <button type="button" onClick={() => removeSource(index)} disabled={sources.length === 1} aria-label={`Remove calibration source ${index + 1}`} className="rounded px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40 focus-ring">Remove</button>}
          </div>
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            <input aria-label={`Source name for ${roleLabel[source.role]}`} value={source.sourceName} onChange={(event) => updateSource(index, { sourceName: event.target.value })} disabled={!canManage} placeholder="Source / server name" className="rounded-md border border-[#1E293B] bg-[#090B13] px-2.5 py-2 font-mono text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60" />
            <input aria-label={`Parameter for ${roleLabel[source.role]}`} value={source.parameter} onChange={(event) => updateSource(index, { parameter: event.target.value })} disabled={!canManage} placeholder="Parameter name" className="rounded-md border border-[#1E293B] bg-[#090B13] px-2.5 py-2 font-mono text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60" />
            <input aria-label={`Register address for ${roleLabel[source.role]}`} value={source.address} onChange={(event) => updateSource(index, { address: event.target.value })} disabled={!canManage} placeholder="Register address" className="rounded-md border border-[#1E293B] bg-[#090B13] px-2.5 py-2 font-mono text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60" />
            <div className="grid grid-cols-2 gap-2">
              <select aria-label={`Engineering unit for ${roleLabel[source.role]}`} value={source.unit} disabled={!canManage} onChange={(event) => updateSource(index, { unit: event.target.value as PlantCalibrationSource['unit'] })} className="rounded-md border border-[#1E293B] bg-[#090B13] px-2 py-2 text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60">
                {(source.role === 'acPower' ? ['W', 'kW', 'MW'] : ['Wh', 'kWh', 'MWh']).map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
              <input inputMode="decimal" aria-label={`Scaling multiplier for ${roleLabel[source.role]}`} value={String(source.multiplier)} onChange={(event) => updateSource(index, { multiplier: Number(event.target.value) })} disabled={!canManage} placeholder="Multiplier" className="rounded-md border border-[#1E293B] bg-[#090B13] px-2 py-2 font-mono text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-60" />
            </div>
          </div>
          <p className="mt-2 text-[9px] text-slate-500">Confirmed role: {source.counterRole.replaceAll('-', ' ')} · raw value × {source.multiplier || '—'} → {source.unit}</p>
        </div>)}
      </div>
      {canManage && <button type="button" onClick={addSource} data-testid="button-add-calibration-source" className="w-full rounded-lg border border-dashed border-[#334155] px-3 py-2 text-[11px] font-semibold text-slate-400 hover:border-blue-500/50 hover:text-blue-300 focus-ring">Add another approved source</button>}
      <div data-testid="calibration-preview-panel" className="rounded-lg border border-blue-500/20 bg-blue-500/[0.04] p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-blue-200">Live register verification</h4>
            <p className="mt-1 text-[10px] leading-5 text-slate-400">{canManage ? 'Read-only check against current broker evidence. It never changes the active profile or dashboard KPIs.' : 'Live raw broker evidence is restricted to authorized administrators.'}</p>
          </div>
          <button type="button" onClick={() => void verify()} disabled={!canManage || previewing} data-testid="button-verify-calibration" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-blue-500/30 bg-blue-600/15 px-3 py-2 text-[10px] font-bold text-blue-200 transition-colors hover:bg-blue-600/25 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"><RefreshCw size={13} className={previewing ? 'animate-spin' : ''} /> {previewing ? 'Checking…' : canManage ? 'Verify current registers' : 'Administrator access required'}</button>
        </div>
        {preview && <p className="mt-3 border-t border-blue-500/10 pt-2 text-[10px] text-slate-500">Checked {new Date(preview.checkedAt).toLocaleString()} · {preview.sourceStatus}. Results are evidence only until this profile is approved.</p>}
      </div>
      {preview && <div className="space-y-2" data-testid="calibration-preview-results">
        {sources.map((source, index) => {
          const result = preview.mappings.find((mapping) => mapping.index === index);
          const calculation = calibrationPreviewCalculation(result?.evidence?.rawValue ?? null, source);
          const status = result?.status ?? 'invalid';
          const statusLabel = status === 'matched' ? 'Current match' : status === 'stale' ? 'Stale · not current' : status === 'retained' ? 'Retained · not current' : status === 'not-found' ? 'No current match' : 'Needs details';
          const statusTone = status === 'matched' ? 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300' : status === 'retained' || status === 'stale' ? 'border-amber-500/25 bg-amber-500/[0.06] text-amber-300' : 'border-rose-500/25 bg-rose-500/[0.06] text-rose-300';
          return <div key={`preview-${index}`} className={`rounded-lg border p-3 ${statusTone}`} data-testid={`calibration-preview-result-${index}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider">{roleLabel[source.role]} · {statusLabel}</span>
              {result?.evidence && <span className="font-mono text-[10px] text-slate-400">raw {result.evidence.rawValue}</span>}
            </div>
            <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-[10px] text-slate-400 min-[420px]:grid-cols-2">
              <span>Source: <strong className="font-mono font-medium text-slate-300">{source.sourceName || '—'}</strong></span>
              <span>Parameter: <strong className="font-mono font-medium text-slate-300">{source.parameter || '—'}</strong></span>
              <span>Address: <strong className="font-mono font-medium text-slate-300">{source.address || '—'}</strong></span>
              <span>Normalized: <strong className="font-mono font-medium text-slate-200">{calculation.normalizedValue === null ? '—' : `${calculation.normalizedValue} ${calculation.target}`}</strong></span>
            </div>
            <p className="mt-2 font-mono text-[10px] text-slate-300">Formula: {calculation.formula}</p>
            {result?.evidence?.receivedAt && <p className="mt-1 text-[9px] text-slate-500">Received {new Date(result.evidence.receivedAt).toLocaleString()}{result.evidence.observedAt ? ` · source time ${new Date(result.evidence.observedAt).toLocaleString()}` : ''}</p>}
            {result?.reason && <p className="mt-1 text-[10px] text-current/80">{result.reason}</p>}
          </div>;
        })}
      </div>}
      {!canManage && <a href="/api/login?returnTo=/" className="inline-flex text-xs font-semibold text-blue-300 underline underline-offset-2 hover:text-blue-200 focus-ring">Sign in as an authorized administrator to approve calibration</a>}
      {error && <p role="alert" data-testid="alert-plant-calibration" className="text-xs text-rose-400">{error}</p>}
      {saved && <p role="status" data-testid="status-plant-calibration-saved" className="text-xs text-emerald-400">{saved}</p>}
      {canManage && <button type="button" onClick={() => void save()} disabled={saving} data-testid="button-save-plant-calibration" className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-600 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-500/10 transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 focus-ring"><Check size={15} /> {saving ? 'Approving…' : profile ? 'Update approved calibration' : 'Approve plant calibration'}</button>}
    </div>
  );
}

function BrokerPanel({ open, onClose, connected, onConnect, onDisconnect, error, sites, initialSite, siteLocations, siteLocationError, canManageCalibration, calibrationProfile, calibrationProfileError, onSaveCalibrationProfile, onPreviewCalibrationProfile }: {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  error: string;
  sites: string[];
  initialSite: string;
  siteLocations: Record<string, PlantLocation>;
  siteLocationError: string;
  canManageCalibration: boolean;
  calibrationProfile: PlantCalibrationProfile | null;
  calibrationProfileError: string;
  onSaveCalibrationProfile: (siteName: string, installedDcCapacityKwp: number, sources: PlantCalibrationSource[]) => Promise<void>;
  onPreviewCalibrationProfile: (siteName: string, sources: PlantCalibrationSource[]) => Promise<CalibrationPreviewResponse>;
}) {
  const [locationSite, setLocationSite] = useState(initialSite);
  const [locationLatitude, setLocationLatitude] = useState('');
  const [locationLongitude, setLocationLongitude] = useState('');
  const dialogRef = useModalAccessibility(onClose, open);
  const locationSiteOptions = useMemo(
    () => sites.length ? sites : initialSite ? [initialSite] : [],
    [initialSite, sites],
  );
  const handleConnect = () => onConnect();
  useEffect(() => {
    if (!locationSiteOptions.length) {
      setLocationSite('');
      return;
    }
    setLocationSite((current) => locationSiteOptions.includes(current) ? current : locationSiteOptions.includes(initialSite) ? initialSite : locationSiteOptions[0]);
  }, [initialSite, locationSiteOptions]);
  useEffect(() => {
    const saved = locationSite ? siteLocations[locationSite] : undefined;
    setLocationLatitude(saved ? String(saved.latitude) : '');
    setLocationLongitude(saved ? String(saved.longitude) : '');
  }, [locationSite, siteLocations[locationSite]?.latitude, siteLocations[locationSite]?.longitude]);
  if (!open) return null;
  
  return (
    <>
      <button type="button" aria-label="Close broker settings" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-slate-950/55 backdrop-blur-[2px]" />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="telemetry-settings-title" tabIndex={-1} className="scada-safe-drawer fixed right-0 top-0 z-50 flex h-[100dvh] min-h-0 w-full max-w-[440px] flex-col border-l border-[#1E293B] bg-[#090B13] shadow-2xl sm:w-[min(88vw,440px)]">
        <div className="scada-safe-drawer-header flex items-center justify-between border-b border-[#1E293B] px-4 py-5 sm:px-6">
          <div>
            <h2 id="telemetry-settings-title" className="text-lg font-bold text-slate-100 tracking-tight">Settings</h2>
            <p className="text-xs text-slate-400 mt-1">Configure telemetry connection</p>
          </div>
           <button type="button" aria-label="Close settings" data-testid="button-close-settings" title="Close settings" onClick={onClose} className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] rounded-lg transition-colors focus-ring">
            <X size={18} />
          </button>
        </div>
        
        <div className="scada-safe-drawer-content min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain px-4 py-6 scrollbar-thin sm:px-6">
           <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.04] px-3 py-3 text-xs leading-5 text-blue-100/80">
             <p className="font-semibold text-blue-300">Live broker connection</p>
             <p className="mt-1">The MQTT endpoint and subscription are managed securely by the server. This dashboard only displays the broker telemetry it receives; browser settings cannot substitute or simulate plant data.</p>
           </div>

           <div className="space-y-4 border-t border-[#1E293B] pt-5">
             <div>
               <div className="flex items-center justify-between gap-3">
                 <div>
                   <h3 className="text-xs font-bold text-slate-300">Verified plant locations</h3>
                   <p className="mt-1 text-[10px] leading-5 text-slate-500">Verified coordinates used to retrieve weather for the selected plant.</p>
                 </div>
                 <MapPin size={16} className="text-orange-400" />
               </div>
             </div>
               {locationSiteOptions.length ? (
               <>
                  <div data-testid="plant-location-access" className="flex items-start gap-2 rounded-lg border border-slate-500/20 bg-slate-500/5 px-3 py-2.5 text-[11px] leading-5 text-slate-400">
                    <MapPin size={14} className="mt-0.5 shrink-0" />
                    <span>View-only site context. Coordinates are centrally managed and audited in Platform Admin.</span>
                  </div>
                 <label className="block">
                   <span className="mb-2 block text-xs font-bold text-slate-300">Plant/site</span>
                     <select value={locationSite} onChange={(event) => setLocationSite(event.target.value)} data-testid="select-plant-location-site" className="w-full rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-3 text-xs font-semibold text-slate-200 focus:border-blue-500 focus:outline-none">
                      {locationSiteOptions.map((site) => <option key={site} value={site}>{site}</option>)}
                   </select>
                 </label>
                  <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
                   <label className="block">
                     <span className="mb-2 block text-xs font-bold text-slate-300">Latitude</span>
                      <input aria-label="Plant latitude" data-testid="input-plant-latitude" value={locationLatitude} readOnly placeholder="Unavailable" className="w-full cursor-default rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-3 font-mono text-xs text-slate-200 focus:outline-none" />
                   </label>
                   <label className="block">
                     <span className="mb-2 block text-xs font-bold text-slate-300">Longitude</span>
                      <input aria-label="Plant longitude" data-testid="input-plant-longitude" value={locationLongitude} readOnly placeholder="Unavailable" className="w-full cursor-default rounded-lg border border-[#1E293B] bg-[#0b0f19] px-3 py-3 font-mono text-xs text-slate-200 focus:outline-none" />
                   </label>
                 </div>
                    <p className="text-[10px] leading-5 text-slate-500">Saved coordinates are used to refresh the resolved place name, timezone, and weather data. Update them in Platform Admin.</p>
                  {siteLocationError && <p role="alert" data-testid="alert-plant-location-load" className="text-xs text-rose-400">{siteLocationError}</p>}
               </>
               ) : <p className="rounded-lg border border-dashed border-[#1E293B] px-3 py-4 text-xs text-slate-500">A plant/site name is required before coordinates can be displayed.</p>}
           </div>
              <CalibrationProfileEditor siteName={initialSite} profile={calibrationProfile} canManage={canManageCalibration} onSave={onSaveCalibrationProfile} onPreview={onPreviewCalibrationProfile} />
             {calibrationProfileError && <p role="alert" data-testid="alert-plant-calibration-load" className="text-xs text-rose-400">{calibrationProfileError}</p>}
          
          {error && (
            <div className="flex gap-3 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-lg">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
        
        <div className="scada-safe-drawer-footer border-t border-[#1E293B] bg-[#090B13] p-4 sm:p-6">
          {connected ? (
             <button type="button" onClick={onDisconnect} data-testid="button-disconnect-broker" className="w-full flex items-center justify-center gap-2 py-3 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 text-sm font-bold rounded-lg transition-colors focus-ring"><WifiOff size={16} /> Disconnect</button>
          ) : (
             <button type="button" onClick={handleConnect} data-testid="button-connect-broker" className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-lg shadow-lg shadow-blue-500/20 transition-colors focus-ring"><PlugZap size={16} /> Connect to Broker</button>
          )}
        </div>
      </section>
    </>
  );
}

const InverterDetailPanel = lazy(() => import('@/components/inverter-detail-panel'));
const ReportCenter = lazy(() => import('@/components/report-center'));

function ScadaCredentialLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/scada-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Unable to sign in to SCADA.');
      setPassword('');
      onSignedIn();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Unable to sign in to SCADA.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="scada-sign-in-title" className="grid min-h-[60vh] place-items-center rounded-2xl border border-dashed border-[color-mix(in_srgb,var(--scada-accent)_35%,transparent)] bg-[var(--scada-accent-soft)] p-4 text-center sm:p-8">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-[var(--scada-border)] bg-[var(--scada-surface)] p-6 text-left shadow-[var(--scada-shadow)] sm:p-8">
        <div className="flex flex-col items-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--scada-accent)_25%,transparent)] bg-[var(--scada-accent-soft)] text-[var(--scada-accent)]">
            <MapPin size={28} aria-hidden="true" />
          </div>
          <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--scada-accent)]">Secure operator access</p>
          <h1 id="scada-sign-in-title" className="mt-2 text-center text-xl font-bold tracking-tight text-[var(--scada-text)]">Sign in to SCADA</h1>
          <p className="mt-3 max-w-sm text-center text-sm leading-6 text-[var(--scada-muted)]">Use the username and password created for you in Platform Admin. Your SCADA session remains separate from Platform Admin.</p>
        </div>
        <div className="mt-7 space-y-4">
          <label className="block" htmlFor="scada-username">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--scada-muted)]">Username</span>
            <input id="scada-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" required placeholder="Enter your username" className="mt-2 h-12 w-full rounded-xl border border-[var(--scada-border)] bg-[var(--scada-surface-raised)] px-3.5 text-sm text-[var(--scada-text)] outline-none transition placeholder:text-[var(--scada-muted)] focus:border-[var(--scada-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--scada-accent)_25%,transparent)] focus-ring" />
          </label>
          <label className="block" htmlFor="scada-password">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--scada-muted)]">Password</span>
            <input id="scada-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder="Enter your password" className="mt-2 h-12 w-full rounded-xl border border-[var(--scada-border)] bg-[var(--scada-surface-raised)] px-3.5 text-sm text-[var(--scada-text)] outline-none transition placeholder:text-[var(--scada-muted)] focus:border-[var(--scada-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--scada-accent)_25%,transparent)] focus-ring" />
          </label>
        </div>
        {error && <p id="scada-login-error" role="alert" aria-live="polite" className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-3 text-xs leading-5 text-rose-700 dark:text-rose-200">{error}</p>}
        <button type="submit" disabled={submitting} aria-busy={submitting} className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--scada-accent)] px-4 text-sm font-bold text-white shadow-lg shadow-blue-500/15 transition hover:brightness-110 focus-ring disabled:cursor-not-allowed disabled:opacity-60">{submitting && <RefreshCw size={16} className="animate-spin" aria-hidden="true" />}{submitting ? 'Signing in…' : 'Sign in to SCADA'}</button>
        <p className="mt-5 text-center text-[11px] leading-5 text-[var(--scada-muted)]">Access is limited to active SCADA operator accounts. Contact your platform administrator if you need access.</p>
      </form>
    </section>
  );
}

function AppShell() {
  // Saved backend evidence hydrates independently; live MQTT/SSE is an
  // additive real-time layer and must never gate the dashboard render.
  const [mode] = useState<'demo' | 'live'>('live');
  const [devices, setDevices] = useState<Device[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem('solar-scada-theme') as ThemeMode) || 'dark');
  const [connected, setConnected] = useState(false);
  const [lastTelemetryAt, setLastTelemetryAt] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => localStorage.getItem('solar-scada-navigation-collapsed') === 'true');
  const [activeSection, setActiveSection] = useState('overview');
  useDeferredChartLibrary(activeSection !== 'reports' && activeSection !== 'settings');
  const [selectedInverterId, setSelectedInverterId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [rawPayload, setRawPayload] = useState('Waiting for the first MQTT payload…');
  const [rawJson, setRawJson] = useState<JsonValue | null>(null);
  const [rawPayloadSource, setRawPayloadSource] = useState<'waiting' | 'replay' | 'retained' | 'recovered' | 'live'>('waiting');
  const [modbusRows, setModbusRows] = useState<ModbusRow[]>([]);
  const [energyStream, setEnergyStream] = useState<LiveEnergySample[]>([]);
  const [sourceBackedInverterRecords, setSourceBackedInverterRecords] = useState<ValidatedInverterPowerRecord[]>([]);
  const [persistence, setPersistence] = useState<PersistenceStatus>({ intervalMinutes: 15, pendingMessages: 0 });
  const [communication, setCommunication] = useState<CommunicationHealth | null>(null);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>('idle');
  const [recoveredEventCount, setRecoveredEventCount] = useState(0);
  const [duplicateEventCount, setDuplicateEventCount] = useState(0);
  const [resyncNotice, setResyncNotice] = useState('');
  const [savedKpiSnapshot, setSavedKpiSnapshot] = useState<SavedKpiSnapshot | null>(null);
  const [savedSnapshotLoadState, setSavedSnapshotLoadState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [rawTopic, setRawTopic] = useState(DEFAULT_BROKER_TOPIC);
  const [activeSite, setActiveSite] = useState('');
  const [siteAccessState, setSiteAccessState] = useState<{ sites: string[]; roles: Record<string, string>; activations: Record<string, 'active' | 'inactive'>; global: boolean; loading: boolean; error: string }>({ sites: [], roles: {}, activations: {}, global: false, loading: true, error: '' });
  const [scadaSession, setScadaSession] = useState<{ loading: boolean; authenticated: boolean }>({ loading: true, authenticated: false });
  const [authRefreshToken, setAuthRefreshToken] = useState(0);
  const [weatherState, setWeatherState] = useState<WeatherState>({ status: 'unavailable', message: 'No configured coordinates are available for the selected plant/site.' });
  const [weatherRefreshToken, setWeatherRefreshToken] = useState(0);
  const [siteLocations, setSiteLocations] = useState<Record<string, PlantLocation>>({});
  const [siteLocationError, setSiteLocationError] = useState('');
  const [locationAdmin, setLocationAdmin] = useState(false);
  const [calibrationProfile, setCalibrationProfile] = useState<PlantCalibrationProfile | null>(null);
  const [calibrationProfileError, setCalibrationProfileError] = useState('');
  const telemetryMappingStoreRef = useRef(createTelemetryMappingStore());
  const applySnapshotMappings = useCallback((snapshot: SavedKpiSnapshot): SavedKpiSnapshot => ({
    ...snapshot,
    parameters: telemetryMappingStoreRef.current.apply((snapshot.parameters ?? []) as ModbusRow[]) as typeof snapshot.parameters,
  }), []);
  const acceptConfirmedSnapshot = useCallback((snapshot: SavedKpiSnapshot, siteName: string) => {
    if (snapshot.saveStatus !== 'saved' || !siteName) return;
    const mappedSnapshot = applySnapshotMappings(snapshot);
    writeConfirmedSnapshotCache(localStorage, siteName, mappedSnapshot);
    setSavedKpiSnapshot((current) => isNewerSavedKpiSnapshot(mappedSnapshot, current) ? mappedSnapshot : current);
  }, [applySnapshotMappings]);
  const refreshTelemetryMappings = useCallback(async (siteName: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/mqtt/telemetry-mappings?siteName=${encodeURIComponent(siteName)}`, {
      signal,
      cache: 'no-store',
    });
    const payload = await response.json() as { mappings?: ScadaTelemetryMapping[]; message?: string };
    if (!response.ok || !Array.isArray(payload.mappings)) {
      throw new Error(payload.message ?? 'Telemetry mappings could not be loaded.');
    }
    if (signal?.aborted) return;
    telemetryMappingStoreRef.current.setMappings(payload.mappings);
    setModbusRows((current) => telemetryMappingStoreRef.current.apply(current) as ModbusRow[]);
    setSavedKpiSnapshot((current) => current ? applySnapshotMappings(current) : current);
  }, [applySnapshotMappings]);
  const streamRef = useRef<EventSource | null>(null);
  const streamGenerationRef = useRef(0);
  const seenTelemetryEventsRef = useRef(new Map<string, true>());
  const energyStreamScopeRef = useRef('');

  useEffect(() => {
    localStorage.setItem('solar-scada-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  useEffect(() => { localStorage.setItem('solar-scada-navigation-collapsed', String(navigationCollapsed)); }, [navigationCollapsed]);
  useEffect(() => {
    const controller = new AbortController();
    const loadScadaSession = async () => {
      try {
        const response = await fetch('/api/auth/user', { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { user?: unknown | null };
        if (!response.ok) throw new Error('SCADA sign-in status could not be checked.');
        setScadaSession({ loading: false, authenticated: payload.user !== null && payload.user !== undefined });
      } catch {
        if (!controller.signal.aborted) setScadaSession({ loading: false, authenticated: false });
      }
    };
    void loadScadaSession();
    return () => controller.abort();
  }, [authRefreshToken]);
  useEffect(() => {
    const controller = new AbortController();
    const loadSiteAccess = async () => {
      try {
        const response = await fetch('/api/mqtt/site-access', { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { sites?: string[]; roles?: Record<string, string>; activations?: Record<string, 'active' | 'inactive'>; global?: boolean; message?: string };
        if (!response.ok || !Array.isArray(payload.sites)) throw new Error(payload.message ?? 'Site access could not be loaded.');
        setSiteAccessState({ sites: payload.sites, roles: payload.roles ?? {}, activations: payload.activations ?? {}, global: payload.global === true, loading: false, error: '' });
        if (payload.sites.length && !activeSite) setActiveSite(payload.sites[0]);
      } catch (loadError) {
        if (!controller.signal.aborted) setSiteAccessState((current) => ({ ...current, loading: false, error: loadError instanceof Error ? loadError.message : 'Site access could not be loaded.' }));
      }
    };
    void loadSiteAccess();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const loadSiteLocations = async () => {
      try {
        const response = await fetch('/api/mqtt/site-locations', { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { locations?: PlantLocation[]; message?: string };
        if (!response.ok || !Array.isArray(payload.locations)) throw new Error(payload.message ?? 'Saved plant locations could not be loaded.');
        setSiteLocations(Object.fromEntries(payload.locations.map((location) => [location.siteName, location])));
        setSiteLocationError('');
      } catch (loadError) {
        if (!controller.signal.aborted) setSiteLocationError(loadError instanceof Error ? loadError.message : 'Saved plant locations could not be loaded.');
      }
    };
    void loadSiteLocations();
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (mode !== 'live') return;
    if (!scadaSession.authenticated || !activeSite) {
      if (activeSite) clearConfirmedSnapshotCache(localStorage, activeSite);
      setSavedKpiSnapshot(null);
      setSavedSnapshotLoadState('idle');
      return;
    }
    const cachedSnapshot = readConfirmedSnapshotCache(localStorage, activeSite);
    setSavedKpiSnapshot(cachedSnapshot ? applySnapshotMappings(cachedSnapshot) : null);
    setSavedSnapshotLoadState(cachedSnapshot ? 'ready' : 'loading');
    const controller = new AbortController();
    const loadSavedKpiSnapshot = async () => {
      try {
        const response = await fetch(`/api/mqtt/snapshots/latest?siteName=${encodeURIComponent(activeSite)}`, { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json().catch(() => ({})) as { snapshot?: unknown; message?: string };
        if (!response.ok) throw new Error(payload.message ?? 'The latest saved backend record could not be loaded.');
        if (controller.signal.aborted) return;
        const parsedSnapshot = parseSavedKpiSnapshot(payload.snapshot);
        const snapshot = parsedSnapshot;
        if (snapshot?.saveStatus === 'saved') {
          acceptConfirmedSnapshot(snapshot, activeSite);
          setSavedSnapshotLoadState('ready');
        } else {
          // A missing or malformed refresh response is not evidence that a
          // previously confirmed record disappeared. Keep the last saved
          // record visible until a newer valid snapshot is confirmed.
          setSavedSnapshotLoadState(cachedSnapshot ? 'ready' : 'empty');
        }
      } catch (loadError) {
        if (controller.signal.aborted) return;
        // Keep any confirmed cache or newer snapshot already received through
        // SSE. Live stream failure must not erase saved backend evidence.
        setSavedSnapshotLoadState('error');
      }
    };
    void loadSavedKpiSnapshot();
    const refreshTimer = window.setInterval(() => void loadSavedKpiSnapshot(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, [acceptConfirmedSnapshot, activeSite, applySnapshotMappings, mode, scadaSession.authenticated]);
  useEffect(() => {
    const controller = new AbortController();
    const loadLocationPermissions = async () => {
      try {
        const response = await fetch('/api/auth/user', { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { canUpdatePlantLocations?: boolean };
        if (!response.ok) throw new Error('Unable to load location permissions.');
        setLocationAdmin(payload.canUpdatePlantLocations === true);
      } catch {
        if (!controller.signal.aborted) setLocationAdmin(false);
      }
    };
    void loadLocationPermissions();
    return () => controller.abort();
  }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10000); return () => window.clearInterval(timer); }, []);
  const availableSites = useMemo(
    () => siteAccessState.global
      ? Array.from(new Set([...devices.map((device) => device.site).filter(Boolean), ...Object.keys(siteLocations)]))
        .filter((site) => siteAccessState.activations[site] !== 'inactive')
        .sort()
      : siteAccessState.sites.filter((site) => siteAccessState.activations[site] !== 'inactive'),
    [devices, siteLocations, siteAccessState.activations, siteAccessState.global, siteAccessState.sites],
  );
  useEffect(() => {
    if (availableSites.length && !availableSites.includes(activeSite)) setActiveSite(availableSites[0]);
  }, [activeSite, availableSites]);
  const plantSiteName = activeSite;
  const selectedSiteIsInactive = Boolean(plantSiteName && siteAccessState.activations[plantSiteName] === 'inactive');
  const scadaAccessState = selectedSiteIsInactive ? 'denied' : dashboardAccessState(siteAccessState, plantSiteName);
  const inactiveAssignedSites = siteAccessState.sites.filter((site) => siteAccessState.activations[site] === 'inactive');
  const weatherLocation = useMemo(() => findWeatherLocation(plantSiteName, siteLocations), [plantSiteName, siteLocations]);
  useEffect(() => {
    if (!scadaSession.authenticated || !plantSiteName) {
      setCalibrationProfile(null);
      setCalibrationProfileError('');
      return;
    }
    const controller = new AbortController();
    const loadCalibrationProfile = async () => {
      try {
        const response = await fetch(`/api/mqtt/calibration-profile?siteName=${encodeURIComponent(plantSiteName)}`, { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { profile?: PlantCalibrationProfile | null; message?: string };
        if (!response.ok) throw new Error(payload.message ?? 'Approved plant calibration could not be loaded.');
        setCalibrationProfile(payload.profile ?? null);
        setCalibrationProfileError('');
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setCalibrationProfile(null);
          setCalibrationProfileError(loadError instanceof Error ? loadError.message : 'Approved plant calibration could not be loaded.');
        }
      }
    };
    void loadCalibrationProfile();
    return () => controller.abort();
  }, [plantSiteName, scadaSession.authenticated]);
  useEffect(() => {
    if (!scadaSession.authenticated || !plantSiteName) {
      telemetryMappingStoreRef.current.setMappings([]);
      return;
    }
    const controller = new AbortController();
    const loadTelemetryMappings = async () => {
      try {
        await refreshTelemetryMappings(plantSiteName, controller.signal);
      } catch {
        if (!controller.signal.aborted) {
          telemetryMappingStoreRef.current.setMappings([]);
          setModbusRows((current) => telemetryMappingStoreRef.current.apply(current) as ModbusRow[]);
          setSavedKpiSnapshot((current) => current ? applySnapshotMappings(current) : current);
        }
      }
    };
    void loadTelemetryMappings();
    const refresh = window.setInterval(() => void loadTelemetryMappings(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
    };
  }, [plantSiteName, refreshTelemetryMappings, scadaSession.authenticated]);

  useEffect(() => {
    if (!weatherLocation) {
      setWeatherState({ status: 'unavailable', message: 'Weather data unavailable for this site: configure a verified plant location.' });
      return;
    }
    const controller = new AbortController();
    const currentLocation = weatherLocation;
    const loadWeather = async () => {
      setWeatherState({ status: 'loading', location: currentLocation });
      try {
        const response = await fetch(`/api/weather?latitude=${encodeURIComponent(currentLocation.latitude)}&longitude=${encodeURIComponent(currentLocation.longitude)}`, { signal: controller.signal });
        const payload = await response.json() as WeatherData & { message?: string };
        if (!response.ok || !payload.available) throw new Error(payload.message ?? 'Weather provider did not return live data.');
        setWeatherState({ status: payload.freshness.cacheStatus === 'cached' ? 'stale' : 'ready', location: currentLocation, data: payload });
      } catch (weatherError) {
        if (controller.signal.aborted) return;
        setWeatherState({
          status: 'unavailable',
          location: currentLocation,
          message: `Data unavailable: ${weatherError instanceof Error ? weatherError.message : 'weather refresh failed.'}`,
        });
      }
    };
    void loadWeather();
    const timer = window.setInterval(() => void loadWeather(), 5 * 60 * 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [weatherLocation?.latitude, weatherLocation?.longitude, weatherLocation?.source, weatherRefreshToken]);

  const ingestPayload = (raw: string, topic: string, receivedAt?: string, replay = false, recovered = false, retained = false, inverterRecords?: unknown[], eventId?: string, calibratedParameter?: unknown) => {
    const identity = telemetryDeliveryIdentity(eventId, topic, receivedAt, raw);
    if (!rememberTelemetryDelivery(seenTelemetryEventsRef.current, identity)) {
      setDuplicateEventCount((count) => count + 1);
      return false;
    }
    const provenance: TelemetryProvenance = replay ? 'replay' : recovered ? 'recovered' : retained ? 'retained' : 'live';
    setRawPayload(raw);
    setRawTopic(topic);
    setRawPayloadSource(provenance);
    try {
      const payload = JSON.parse(raw) as JsonValue;
      setRawJson(payload);
      const incomingRows = telemetryMappingStoreRef.current.apply(
        extractModbusRows(isUnknownRecord(calibratedParameter) ? calibratedParameter as JsonValue : payload),
      ) as ModbusRow[];
      if (incomingRows.length) {
        setModbusRows((current) => {
          const next = [...current];
          for (const row of incomingRows) {
            const incoming = { ...row, provenance, serverReceivedAt: receivedAt ?? new Date().toISOString() };
            const existingIndex = next.findIndex((row) => modbusRowKey(row) === modbusRowKey(incoming));
            if (existingIndex >= 0) {
              if (shouldReplaceTelemetryRow(next[existingIndex]!, incoming)) next[existingIndex] = incoming;
            } else {
              next.push(incoming);
            }
          }
          return next;
        });
      }
      if (!promotesOperationalTelemetry(provenance)) return;
      const incomingEnergySamples = liveEnergySamplesFromRows(incomingRows, receivedAt ?? new Date().toISOString());
      if (incomingEnergySamples.length) {
        setEnergyStream((current) => appendLiveEnergySamples(current, incomingEnergySamples));
      }
      const canonicalInverterRecords = (inverterRecords ?? []).map(apiValidatedInverterRecord).filter((record): record is ValidatedInverterPowerRecord => Boolean(record));
      if (canonicalInverterRecords.length) {
        setSourceBackedInverterRecords((current) => {
          const next = [...current];
          for (const record of canonicalInverterRecords) {
            const index = next.findIndex((item) => item.inverterId === record.inverterId && item.parameter === record.parameter);
            if (index < 0 || Date.parse(record.sourceTimestamp) >= Date.parse(next[index]!.sourceTimestamp)) next[index] = record;
          }
          return next.slice(-100);
        });
      }
      const receivedAtMs = receivedAt ? new Date(receivedAt).getTime() : NaN;
      const observedAt = Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
      setLastTelemetryAt((current) => current === null || observedAt > current ? observedAt : current);
      const discovered = extractDevices(payload);
      if (!discovered.length) throw new Error('not an object');
      setDevices((current) => discovered.reduce((next, telemetry, index) => {
        const identity = String(telemetry.id || telemetry.device || telemetry.name || `discovered-device-${index + 1}`);
        const existing = next.find((device) => device.id === identity);
        const device: Device = {
          id: identity,
          name: String(telemetry.name || telemetry.deviceName || identity),
          site: String(telemetry.site || telemetry.location || 'Discovered site'),
          type: String(telemetry.type || telemetry.deviceType || 'MQTT device'),
          status: 'online',
          lastSeen: observedAt,
          telemetry: { ...telemetry, mappedEvidence: incomingRows.filter((row) => String(row.device_id ?? row.deviceId ?? row.inverter_id ?? row.inverterId ?? '') === identity) },
        };
        return existing ? next.map((item) => item.id === identity ? { ...item, ...device } : item) : [device, ...next];
      }, current));
      if (provenance === 'live') setError('');
    } catch {
      setRawJson(null);
      if (provenance === 'live') setError('A broker message arrived, but its payload was not valid JSON. The raw payload is still shown below.');
    }
    return true;
  };

  const connect = () => {
    setError('');
    if (mode === 'demo') {
      setConnected(true);
      setSettingsOpen(false);
      return;
    }
    setConnected(false);
    setLastTelemetryAt(null);
    setDevices([]);
    setModbusRows([]);
    setSourceBackedInverterRecords([]);
    setSelectedInverterId(null);
    setRawPayload('Waiting for the first MQTT payload…');
    setRawJson(null);
    setRawPayloadSource('waiting');
    setCommunication(null);
    setStreamPhase('connecting');
    setRecoveredEventCount(0);
    setDuplicateEventCount(0);
    setResyncNotice('');
    streamRef.current?.close();
    const generation = streamGenerationRef.current + 1;
    streamGenerationRef.current = generation;
    if (!plantSiteName) {
      setStreamPhase('closed');
      setError('No assigned site is available. Ask a platform administrator to grant site access.');
      return;
    }
    const stream = new EventSource(`/api/mqtt/stream?siteName=${encodeURIComponent(plantSiteName)}`);
    streamRef.current = stream;
    stream.onopen = () => {
      if (generation !== streamGenerationRef.current) return;
      setStreamPhase('connected');
    };
    stream.addEventListener('status', (event) => {
      if (generation !== streamGenerationRef.current) return;
      try {
        const status = JSON.parse((event as MessageEvent).data) as { connected: boolean; error?: string; persistence?: PersistenceStatus; communication?: CommunicationHealth };
        setConnected(status.connected);
        if (status.persistence) setPersistence(status.persistence);
        if (status.communication) setCommunication(status.communication);
        if (status.connected) setError('');
        else if (status.communication?.subscriptionState === 'pending') setError('Connected to the broker and waiting for topic subscription confirmation.');
        else if (status.communication?.subscriptionState === 'failed') setError(status.error ?? 'The broker connection opened, but the telemetry topic subscription failed.');
        else if (status.error === 'connack timeout') setError('The MQTT broker is not responding to the connection handshake. The dashboard will retry automatically.');
        else setError('MQTT broker transport is reconnecting. Device freshness is tracked separately below.');
      } catch {
        setError('The telemetry status stream sent an unreadable update. The connection will recover automatically.');
      }
    });
    stream.addEventListener('message', (event) => {
      if (generation !== streamGenerationRef.current) return;
      try {
        const message = JSON.parse((event as MessageEvent).data) as { topic: string; payload: string; parameter?: unknown; receivedAt?: string; replay?: boolean; recovered?: boolean; delivery?: 'immediate' | 'retained'; inverterRecords?: unknown[] };
        if (typeof message.topic !== 'string' || typeof message.payload !== 'string') return;
        const accepted = ingestPayload(message.payload, message.topic, message.receivedAt, message.replay === true, message.recovered === true, message.delivery === 'retained', message.inverterRecords, (event as MessageEvent).lastEventId || undefined, message.parameter);
        if (accepted && message.recovered) setRecoveredEventCount((count) => count + 1);
      } catch {
        setError('The telemetry stream sent an unreadable message frame. New frames will continue to be processed.');
      }
    });
    stream.addEventListener('snapshot', (event) => {
      if (generation !== streamGenerationRef.current) return;
      try {
        const parsedSnapshot = parseSavedKpiSnapshot(JSON.parse((event as MessageEvent).data));
        const snapshot = parsedSnapshot;
        if (!snapshot || snapshot.saveStatus !== 'saved') return;
        acceptConfirmedSnapshot(snapshot, plantSiteName);
      } catch {
        setError('The saved snapshot stream sent an unreadable update. Existing KPI evidence is retained.');
      }
    });
    stream.addEventListener('site-activation', (event) => {
      if (generation !== streamGenerationRef.current) return;
      try {
        const update = JSON.parse((event as MessageEvent).data) as { siteName?: string; activationStatus?: 'active' | 'inactive' };
        if (!update.siteName || (update.activationStatus !== 'active' && update.activationStatus !== 'inactive')) return;
        setSiteAccessState((current) => ({
          ...current,
          activations: { ...current.activations, [update.siteName!]: update.activationStatus! },
        }));
        if (update.activationStatus === 'inactive' && update.siteName === plantSiteName) {
          setError('This site was deactivated by a platform administrator. Select another active site when available.');
        }
      } catch {
        setError('The site activation update could not be read. The connection will refresh its access state automatically.');
      }
    });
    stream.addEventListener('telemetry-mapping', (event) => {
      if (generation !== streamGenerationRef.current) return;
      try {
        const update = JSON.parse((event as MessageEvent).data) as { siteName?: string };
        if (!update.siteName || update.siteName !== plantSiteName) return;
        void refreshTelemetryMappings(update.siteName).catch(() => {
          // The 60-second fallback poll remains active if this immediate reload fails.
        });
      } catch {
        // Ignore a malformed control event; broker telemetry delivery continues normally.
      }
    });
    stream.addEventListener('resync', (event) => {
      if (generation !== streamGenerationRef.current) return;
      try {
        const resync = JSON.parse((event as MessageEvent).data) as { reason?: string };
        setResyncNotice(resync.reason ?? 'A stream recovery range was unavailable; the raw inspector was resynchronized from available evidence.');
      } catch {
        setResyncNotice('A stream recovery range was unavailable; the raw inspector was resynchronized from available evidence.');
      }
    });
    stream.addEventListener('heartbeat', () => {
      if (generation === streamGenerationRef.current) setStreamPhase('connected');
    });
    stream.onerror = () => {
      if (generation !== streamGenerationRef.current) return;
      setStreamPhase('reconnecting');
    };
    setSettingsOpen(false);
  };

  useEffect(() => {
    const scope = scadaSession.authenticated && plantSiteName ? plantSiteName : '';
    if (energyStreamScopeRef.current === scope) return;
    energyStreamScopeRef.current = scope;
    setEnergyStream([]);
  }, [plantSiteName, scadaSession.authenticated]);

  useEffect(() => {
    if (mode !== 'live') return;
    connect();
    return () => {
      streamGenerationRef.current += 1;
      streamRef.current?.close();
      streamRef.current = null;
      setStreamPhase('closed');
    };
  }, [acceptConfirmedSnapshot, mode, plantSiteName]);

  const disconnect = () => {
    streamGenerationRef.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    setConnected(false);
    setStreamPhase('closed');
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };
  const navigateTo = (section: string) => {
    setActiveSection(section);
    window.requestAnimationFrame(() => {
      document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      window.setTimeout(() => document.querySelector<HTMLElement>('#overview-heading, [data-testid="workspace-heading"]')?.focus(), 0);
    });
  };
  const refreshTelemetry = () => connect();
  const refreshWeather = () => {
    if (weatherLocation) setWeatherRefreshToken((token) => token + 1);
    else setWeatherState({ status: 'unavailable', message: 'Weather data unavailable for this site: configure a verified plant location.' });
  };
  const changeActiveSite = (site: string) => {
    setActiveSite(site);
    setWeatherState({ status: 'unavailable', message: 'Weather data unavailable for this site: configure a verified plant location.' });
  };
  const saveCalibrationProfile = async (siteName: string, installedDcCapacityKwp: number | null, sources: PlantCalibrationSource[]) => {
    const response = await fetch(`/api/mqtt/calibration-profile/${encodeURIComponent(siteName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installedDcCapacityKwp, sources }),
    });
    const payload = await response.json() as { profile?: PlantCalibrationProfile; message?: string };
    if (!response.ok || !payload.profile) throw new Error(payload.message ?? 'Unable to save the plant calibration profile.');
    if (payload.profile.siteName === plantSiteName) setCalibrationProfile(payload.profile);
    setCalibrationProfileError('');
  };
  const previewCalibrationProfile = async (siteName: string, sources: PlantCalibrationSource[]): Promise<CalibrationPreviewResponse> => {
    const response = await fetch('/api/mqtt/calibration-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName, sources }),
    });
    const payload = await response.json() as CalibrationPreviewResponse & { message?: string };
    if (!response.ok || !Array.isArray(payload.mappings)) throw new Error(payload.message ?? 'Unable to verify calibration mappings against live broker evidence.');
    return payload;
  };
  const openLocationSettings = () => {
    setMobileNav(false);
    setSettingsOpen(true);
  };
  const exportTelemetry = () => {
    const columns = ['record_type', 'kpi', 'calculated_value', 'unit', 'quality', 'method', 'formula', 'calculated_at', 'profile_version', 'included_inputs', 'excluded_outliers', 'snapshot_window'];
    const escapeCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const calculationRows = Object.values(calculations).map((calculation) => [
      'verified_kpi',
      calculation.label,
      calculation.value ?? '',
      calculation.unit ?? '',
      calculation.quality,
      calculation.method,
      calculation.formula,
      calculation.calculatedAt ?? '',
      calculation.profileVersion,
      calculation.inputs.map((source) => `${source.parameter} (${source.address})`).join(' | '),
      calculation.excluded.map((source) => `${source.parameter} (${source.address})`).join(' | '),
      calculation.snapshotWindow ? `${calculation.snapshotWindow.startedAt}/${calculation.snapshotWindow.endedAt}` : '',
    ].map(escapeCell).join(','));
    const evidenceColumns = ['record_type', 'parameter', 'raw_value', 'source_engineering_value', 'source_unit', 'modbus_address', 'source', 'timestamp', 'provenance'];
    const evidenceRows = modbusRows.map((row) => [
      'raw_modbus_evidence',
      row.name ?? '',
      row.raw_data ?? row.data,
      row.data,
      row.engineering_unit ?? row.engineeringUnit ?? row.unit ?? row.units ?? '',
      row.full_addr ?? row.addr ?? '',
      row.server_name ?? 'Modbus',
      row.date_iso_8601 ?? row.timestamp ?? row.date ?? '',
      row.provenance ?? 'live',
    ].map(escapeCell).join(','));
    const blob = new Blob([[columns.join(','), ...calculationRows, '', evidenceColumns.join(','), ...evidenceRows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trn246-live-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const telemetryAge = lastTelemetryAt === null ? null : now - lastTelemetryAt;
  const electricalLiveState: 'fresh' | 'stale' | 'unavailable' = mode === 'demo'
    ? 'fresh'
    : telemetryAge !== null && telemetryAge <= DEVICE_ONLINE_MAX_AGE_MS
      ? 'fresh'
      : communication?.deviceCommunication === 'stale' || (telemetryAge !== null && telemetryAge <= DEVICE_STALE_MAX_AGE_MS)
        ? 'stale'
        : 'unavailable';
  const savedEvidence = selectDashboardSavedEvidence(savedKpiSnapshot);
  const dashboardSavedSnapshot = savedEvidence.snapshot;
  const hasValidSavedSnapshot = dashboardSavedSnapshot !== null;
  const savedSnapshotRows = useMemo(() => (savedKpiSnapshot?.parameters ?? []) as ModbusRow[], [savedKpiSnapshot]);
  const currentLiveRows = useMemo(() => modbusRows.filter((row) => row.provenance === 'live'), [modbusRows]);
  const showingSavedRecord = mode === 'live' && savedEvidence.source === 'saved';
  const dashboardEvidenceRows = showingSavedRecord ? savedSnapshotRows : currentLiveRows;
  const lastSavedLabel = hasValidSavedSnapshot
    ? formatInPlantTimezone(savedKpiSnapshot!.capturedAt, savedKpiSnapshot!.timezone ?? persistence.timezone)
    : 'not available';
  const operationalDevices = useMemo(() => devices.map((device) => ({ ...device, status: statusAt(device, now, mode) })), [devices, mode, now]);
  const rawInverterAssessment = useMemo(() => assessValidatedLiveInverterFleet(
    mode === 'live' ? modbusRows : [],
    { asOf: now, maximumAgeMs: DEVICE_ONLINE_MAX_AGE_MS },
  ), [modbusRows, mode, now]);
  const validatedInverterFleet = useMemo(() => {
    const sourceBackedFleet = assessSourceBackedInverterFleet(
      mode === 'live' ? sourceBackedInverterRecords : [],
      { asOf: now, maximumAgeMs: DEVICE_ONLINE_MAX_AGE_MS },
    );
    const acceptedKeys = new Set(sourceBackedInverterRecords.map((record) => `${record.inverterId}|${record.parameter}`));
    const rejectedRawCandidates = rawInverterAssessment.records
      .filter((record) => !acceptedKeys.has(`${record.inverterId}|${record.parameter}`))
      .map((record) => ({
        parameter: record.parameter,
        inverterId: record.inverterId,
        sourceName: record.sourceName,
        address: record.address,
        reason: 'Source record was not accepted for this configured plant.',
      }));
    return {
      ...sourceBackedFleet,
      excluded: [...sourceBackedFleet.excluded, ...rawInverterAssessment.excluded, ...rejectedRawCandidates],
    };
  }, [mode, now, rawInverterAssessment, sourceBackedInverterRecords]);
  const validatedInverterDevices = useMemo(
    () => validatedInverterFleet.records.map((record) => sourceBackedInverterDevice(record, persistence.inverterEnergySite ?? plantSiteName ?? 'Discovered site')),
    [persistence.inverterEnergySite, plantSiteName, validatedInverterFleet.records],
  );
  const sourceTagInverters = useMemo(() => {
    const latestBySource = new Map<string, Device>();
    for (const row of dashboardEvidenceRows) {
       const signal = rawInverterSignals([row])[0] ?? rawInverterIdentitySignals([row])[0];
      if (!signal) continue;
      const sourceName = String(row.server_name ?? row.server ?? row.source ?? 'MQTT source');
      const sourceTime = row.date_iso_8601 ?? row.timestamp ?? row.date;
      const numericTime = typeof sourceTime === 'number' ? sourceTime : Number(sourceTime);
      const parsedTime = Number.isFinite(numericTime)
        ? new Date(numericTime < 1_000_000_000_000 ? numericTime * 1000 : numericTime).getTime()
        : Date.parse(String(sourceTime ?? ''));
      const observedAt = telemetryDateTime(row).full;
      const rawAge = Number.isFinite(parsedTime) ? now - parsedTime : Number.POSITIVE_INFINITY;
      const reportingState = showingSavedRecord
        ? 'saved' as const
        : mode === 'live' && signal.provenance === 'live' && rawAge >= 0 && rawAge <= DEVICE_ONLINE_MAX_AGE_MS
          ? 'live' as const
          : 'stale' as const;
      const sourceKey = `${sourceName}|${signal.address.toLowerCase()}|${signal.inverterId ?? signal.parameter.toLowerCase()}`;
      const discoveryDeviceId = discoveryDeviceIdFromSourceRecord(row, sourceName);
      const candidate: Device = {
        id: `source-${encodeURIComponent(sourceKey)}`,
        energyInverterId: signal.inverterId ?? signal.parameter.toLowerCase(),
        discoveryDeviceId: signal.inverterId ?? discoveryDeviceId,
        name: signal.inverterId ?? signal.parameter.toUpperCase(),
        site: persistence.inverterEnergySite ?? plantSiteName ?? 'Discovered site',
        type: 'Power inverter',
        status: reportingState === 'live' ? 'online' : 'stale',
        lastSeen: Number.isFinite(parsedTime) ? parsedTime : now,
        telemetry: {
          source_tag: {
            parameter: signal.parameter,
            value: signal.value,
            address: signal.address,
            source_name: sourceName,
            observed_at: observedAt,
            provenance: signal.provenance,
          },
          raw_modbus_row: row,
        },
          sourceEvidence: { ...signal, sourceName, observedAt, reportingState },
      };
      const current = latestBySource.get(sourceKey);
      if (!current || candidate.lastSeen >= current.lastSeen) latestBySource.set(sourceKey, candidate);
    }
    return [...latestBySource.values()];
  }, [dashboardEvidenceRows, mode, now, persistence.inverterEnergySite, plantSiteName, showingSavedRecord]);
  const inverterDisplayDevices = useMemo(() => {
    const sourceIdentity = (device: Device) => {
      const evidence = device.sourceEvidence;
      return evidence ? `${evidence.sourceName ?? ''}|${evidence.address.toLowerCase()}|${evidence.inverterId ?? evidence.parameter.toLowerCase()}` : '';
    };
    const validatedSources = new Set(validatedInverterDevices.map(sourceIdentity));
    if (showingSavedRecord) return sourceTagInverters;
    return [...operationalDevices, ...validatedInverterDevices, ...sourceTagInverters.filter((device) => !validatedSources.has(sourceIdentity(device)))];
  }, [operationalDevices, showingSavedRecord, sourceTagInverters, validatedInverterDevices]);
  const inverters = useMemo(() => operationalDevices.filter(d => d.type === 'Power inverter'), [operationalDevices]);
  const onlinePowerReadings = useMemo(() => electricalLiveState === 'fresh' ? inverters.filter((device) => device.status === 'online').map((device) => {
    const power = numberFrom(device, ['power', 'active_kw'], NaN);
    return Number.isFinite(power) ? power : null;
  }).filter((power): power is number => power !== null) : [], [electricalLiveState, inverters]);
  const totalAcPower = onlinePowerReadings.length ? onlinePowerReadings.reduce((sum, power) => sum + power, 0) : null;
  const selectedInverter = useMemo(() => selectedInverterId ? inverterDisplayDevices.find((device) => device.id === selectedInverterId) ?? null : null, [inverterDisplayDevices, selectedInverterId]);
  const onlineInverters = electricalLiveState === 'fresh' ? inverters.filter(d => d.status === 'online').length : 0;
  const totalInverters = inverters.length;
  const alarmFaultReports = useMemo(() => uniqueAlarmFaultReports([
    ...deviceAlarmFaultReports(operationalDevices),
    ...rowAlarmFaultReports(dashboardEvidenceRows),
  ]), [dashboardEvidenceRows, operationalDevices]);
  const activeAlarms = alarmFaultReports.length;
  const rawKpis = useMemo(() => ({
    activePower: latestRawMetric(dashboardEvidenceRows, ['actpow']),
    dailyEnergy: latestRawMetric(dashboardEvidenceRows, ['todayyield'])
      ?? latestRawCounterMetric(dashboardEvidenceRows, 'daily-counter', ['dailyenergy', 'dailyenergykwh', 'dailyeneregykwh', 'todayenergy', 'todayenergykwh']),
    totalEnergy: latestRawCounterMetric(dashboardEvidenceRows, 'cumulative-counter', ['totalenergy', 'totalenergykwh', 'lifetimeenergy', 'lifetimeenergykwh']),
    specificYield: latestRawMetric(dashboardEvidenceRows, ['todayyield', 'specificyield', 'specificyieldkwhkwp']),
    alarms: latestRawMetric(dashboardEvidenceRows, ['alarm', 'alarms', 'alarmcode', 'fault', 'faultcode']),
    inverters: rawInverterSignals(dashboardEvidenceRows),
  }), [dashboardEvidenceRows]);
  const rawFallbacks = useMemo(() => rawKpiFallbacks(dashboardEvidenceRows), [dashboardEvidenceRows]);
  const liveKpiCalculations = useMemo(() => calculateVerifiedScadaKpis(
    mode === 'live' ? modbusRows.filter((row) => row.provenance === 'live') : modbusRows,
    { asOf: now, maximumAgeMs: DEVICE_STALE_MAX_AGE_MS, calibrationProfile },
  ), [calibrationProfile, modbusRows, mode, now]);
  const savedKpiCalculations = useMemo(() => calculateVerifiedScadaKpis(
    savedKpiSnapshot?.parameters ?? [],
    savedKpiSnapshot ? {
      snapshotWindow: {
        startedAt: savedKpiSnapshot.windowStartedAt,
        endedAt: savedKpiSnapshot.windowEndedAt,
        scheduledFor: savedKpiSnapshot.scheduledFor,
        capturedAt: savedKpiSnapshot.capturedAt,
      },
      calibrationProfile: savedKpiSnapshot.calibrationProfile ?? null,
    } : undefined,
  ), [savedKpiSnapshot]);
  const calculations = useMemo<VerifiedScadaKpis>(() => {
    const primary = showingSavedRecord ? savedKpiCalculations : liveKpiCalculations;
    const secondary = hasValidSavedSnapshot
      ? showingSavedRecord ? liveKpiCalculations : savedKpiCalculations
      : null;
    const select = (key: keyof VerifiedScadaKpis) => secondary
      ? selectVerifiedCalculation(primary[key], secondary[key])
      : primary[key];
    return {
      acPower: select('acPower'),
      dailyEnergy: select('dailyEnergy'),
      totalEnergy: select('totalEnergy'),
      specificYield: select('specificYield'),
    };
  }, [hasValidSavedSnapshot, liveKpiCalculations, savedKpiCalculations, showingSavedRecord]);
  const calculationValue = (calculation: VerifiedKpiCalculation) => calculation.quality === 'verified' ? calculation.value!.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
  const calculationUnit = (calculation: VerifiedKpiCalculation) => calculation.quality === 'verified' ? calculation.unit ?? '' : '';
  const calculationContext = (calculation: VerifiedKpiCalculation) => {
    if (calculation.quality !== 'verified') return calculation.readiness;
    const outliers = calculation.excluded.length ? ` · ${calculation.excluded.length} outlier${calculation.excluded.length === 1 ? '' : 's'} excluded` : '';
    const saved = calculation.snapshotWindow ? ` · saved ${formatInPlantTimezone(calculation.snapshotWindow.capturedAt, persistence.timezone)}` : '';
    return `${calculation.method.replaceAll('-', ' ')} · ${calculation.inputs.length} approved source input${calculation.inputs.length === 1 ? '' : 's'} · ${calculation.profileVersion}${outliers}${saved}`;
  };
  const calculationCard = (calculation: VerifiedKpiCalculation, rawFallback: RawKpiFallback) => {
    if (calculation.quality === 'verified') {
      return {
        value: calculationValue(calculation),
        unit: calculationUnit(calculation),
        details: `${calculation.formula}. ${calculationContext(calculation)}`,
      };
    }
    if (rawFallback.value === null) {
      return {
        value: 'Not reported',
        unit: '',
        details: showingSavedRecord ? `${rawFallback.readiness} Last saved: ${lastSavedLabel}.` : rawFallback.readiness,
      };
    }
    const registerList = rawFallback.inputs.map((input) => `${input.parameter} (${input.address})`).join(' + ');
    return {
      value: rawFallback.value.toLocaleString(undefined, { maximumFractionDigits: 4 }),
      unit: rawFallback.unit,
        details: `${rawFallback.formula}. Source: ${registerList}${rawFallback.sourceUnit ? ` (${rawFallback.sourceUnit})` : ''}. ${rawFallback.inputs.some((input) => input.sourceReported) ? 'Source-reported; engineering scaling is not confirmed.' : 'Engineering scaling is not confirmed.'}${showingSavedRecord ? ` Last saved: ${lastSavedLabel}.` : ''}`,
    };
  };
  const acPowerCard = calculationCard(calculations.acPower, rawFallbacks.acPower);
  const dailyEnergyCard = calculationCard(calculations.dailyEnergy, rawFallbacks.dailyEnergy);
  const totalEnergyCard = calculationCard(calculations.totalEnergy, rawFallbacks.totalEnergy);
  const specificYieldCard = calculationCard(calculations.specificYield, rawFallbacks.specificYield);
  const discoveredInverterTotal = rawKpis.inverters.length;
  const onlineInverterCount = electricalLiveState === 'fresh' ? validatedInverterFleet.records.length : 0;
  const inverterCardValue = showingSavedRecord
    ? discoveredInverterTotal ? `— / ${discoveredInverterTotal}` : '— / Total'
    : discoveredInverterTotal ? `${onlineInverterCount} / ${discoveredInverterTotal}` : '0 / Total';
  const inverterAvailability = showingSavedRecord
    ? 'Saved record'
    : discoveredInverterTotal ? `${Math.round((onlineInverterCount / discoveredInverterTotal) * 100)}%` : '—';
  const displayedActiveAlarmCount = rawKpis.alarms?.value === 0 ? 0 : activeAlarms;
  const activeAlarmCardCount = mode === 'demo' ? activeAlarms : displayedActiveAlarmCount;
  const inverterCard = mode === 'demo'
    ? {
      value: totalInverters ? `${onlineInverters} / ${totalInverters}` : '0 / Total',
      availability: totalInverters ? `${Math.round((onlineInverters / totalInverters) * 100)}%` : '—',
      status: totalInverters ? 'Demo fleet status' : 'Demo fleet total unavailable',
      help: totalInverters
        ? `Inverters Online. ${onlineInverters} demo inverter${onlineInverters === 1 ? '' : 's'} out of ${totalInverters}.`
        : 'Inverters Online. The demo fleet total is unavailable.',
      tone: onlineInverters ? 'green' : totalInverters ? 'amber' : 'slate',
    }
    : {
      value: inverterCardValue,
      availability: inverterAvailability,
      status: showingSavedRecord
        ? discoveredInverterTotal ? `Saved inventory · ${lastSavedLabel}` : 'Saved record has no mapped inverter source'
        : discoveredInverterTotal ? 'Source-backed inverter status' : 'Awaiting inverter mapping',
      help: discoveredInverterTotal
        ? showingSavedRecord
          ? `Inverters Online. The latest saved record identifies ${discoveredInverterTotal} inverter source record${discoveredInverterTotal === 1 ? '' : 's'}, but cannot verify current online state. Saved: ${lastSavedLabel}.`
          : `Inverters Online. ${onlineInverterCount} verified live inverter${onlineInverterCount === 1 ? '' : 's'} out of ${discoveredInverterTotal} discovered source record${discoveredInverterTotal === 1 ? '' : 's'}.`
        : 'No approved inverter status mapping has reported a total yet.',
      tone: showingSavedRecord ? discoveredInverterTotal ? 'amber' : 'slate' : onlineInverterCount ? 'green' : discoveredInverterTotal ? 'amber' : 'slate',
    };
  const latestApprovedPlantPower = useMemo(() => dashboardEvidenceRows
    .filter((row) => {
      const parameter = String(row.name ?? row.parameter ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const semantic = String(row.measurement_type ?? row.semantic ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      return explicitScalingValidated(row)
        && ['actpow', 'mainmeteractivepower', 'gridactivepower', 'plantactivepower'].includes(parameter)
        && ['activepower', 'acpower', 'realpower'].includes(semantic);
    })
    .map((row) => {
      const reported = sourceReportedValue(row);
      const value = typeof reported === 'number'
        ? reported
        : typeof row.data === 'number' ? row.data : typeof row.data === 'string' ? Number(row.data) : NaN;
      return { row, value, observedAt: telemetryEpoch(row) ?? 0 };
    })
    .filter((candidate) => Number.isFinite(candidate.value))
    .sort((left, right) => right.observedAt - left.observedAt)[0] ?? null,
  [dashboardEvidenceRows]);
  const dashboardFlowReading = useMemo(() => {
    const sourceRowForRawInput = (input: RawTelemetryMetric | undefined) => {
      if (!input) return undefined;
      return dashboardEvidenceRows
        .filter((candidate) => {
          const parameter = String(candidate.name ?? '').trim().toLowerCase();
          const address = String(candidate.full_addr ?? candidate.addr ?? '—');
          const value = typeof candidate.data === 'number' ? candidate.data : Number(candidate.data);
          return parameter === input.parameter.toLowerCase() && address === input.address && Number.isFinite(value) && value === input.value;
        })
        .sort((left, right) => (telemetryEpoch(right) ?? 0) - (telemetryEpoch(left) ?? 0))[0];
    };
    const isFreshTimestamp = (timestamp: string | undefined) => {
      const epoch = timestamp ? Date.parse(timestamp) : NaN;
      const age = now - epoch;
      return Number.isFinite(epoch) && age >= 0 && age <= DEVICE_ONLINE_MAX_AGE_MS;
    };
    const isFreshSourceRow = (row: ModbusRow | undefined) => {
      const epoch = row ? telemetryEpoch(row) : null;
      const age = epoch === null ? NaN : now - epoch;
      return Number.isFinite(epoch) && age >= 0 && age <= DEVICE_ONLINE_MAX_AGE_MS;
    };
    const observationRange = (rows: Array<ModbusRow | undefined>) => {
      const datedRows = rows
        .filter((row): row is ModbusRow => row !== undefined && telemetryEpoch(row) !== null)
        .sort((left, right) => (telemetryEpoch(left) ?? 0) - (telemetryEpoch(right) ?? 0));
      if (!datedRows.length) return undefined;
      const first = telemetryDateTime(datedRows[0]!).full;
      const last = telemetryDateTime(datedRows[datedRows.length - 1]!).full;
      return first === last ? first : `${first} – ${last}`;
    };
    const savedSnapshotTime = savedKpiSnapshot?.capturedAt ?? savedKpiSnapshot?.scheduledFor;
    if (mode === 'demo') {
      return {
        value: totalAcPower,
        unit: 'kW',
        quality: totalAcPower === null ? 'unavailable' as const : 'reported' as const,
        status: totalAcPower === null ? 'offline' as const : 'online' as const,
        sourceLabel: 'Demo inverter aggregate',
        inverterCount: onlinePowerReadings.length || undefined,
      };
    }
    if (!showingSavedRecord && validatedInverterFleet.records.length) {
      const contributingRows = validatedInverterFleet.records.map((record) => ({ date_iso_8601: record.sourceTimestamp }));
      return {
        value: validatedInverterFleet.totalKw,
        unit: 'kW',
        quality: 'reported' as const,
        provenance: 'live' as const,
        status: 'online' as const,
        sourceLabel: `Validated live inverter aggregate · ${validatedInverterFleet.records.length} contributing source record${validatedInverterFleet.records.length === 1 ? '' : 's'}`,
        observedAt: observationRange(contributingRows),
        observationLabel: validatedInverterFleet.records.length > 1 ? 'Contributing timestamps' : 'Observed',
        inverterCount: validatedInverterFleet.records.length,
      };
    }
    if (calculations.acPower.quality === 'verified') {
      const liveInputsFresh = calculations.acPower.inputs.length > 0
        && calculations.acPower.inputs.every((input) => isFreshTimestamp(input.observedAt));
      const live = calculations.acPower.provenance === 'live' && electricalLiveState === 'fresh' && liveInputsFresh;
      const saved = calculations.acPower.provenance === 'snapshot';
      const calculationObservation = observationRange(
        calculations.acPower.inputs.map((input) => input.observedAt ? { date_iso_8601: input.observedAt } : undefined),
      );
      return {
        value: calculations.acPower.value,
        unit: calculations.acPower.unit ?? '',
        quality: calculations.acPower.value === null ? 'unavailable' as const : 'reported' as const,
        provenance: live ? 'live' as const : saved ? 'snapshot' as const : calculations.acPower.provenance === 'replay' ? 'replay' as const : undefined,
        status: live ? 'online' as const : 'stale' as const,
        sourceLabel: `${live ? 'Validated live' : saved ? 'Last saved validated' : 'Validated historical'} · ${calculations.acPower.profileVersion}`,
        observedAt: saved ? savedSnapshotTime : calculationObservation ?? calculations.acPower.calculatedAt,
        observationLabel: saved ? 'Saved snapshot' : calculations.acPower.inputs.length > 1 ? 'Contributing timestamps' : 'Observed',
        inverterCount: calculations.acPower.method === 'inverter-sum' ? calculations.acPower.inputs.length : undefined,
      };
    }
    if (latestApprovedPlantPower) {
      const { row, value } = latestApprovedPlantPower;
      const live = row.provenance === 'live' && electricalLiveState === 'fresh' && isFreshSourceRow(row);
      const saved = showingSavedRecord;
      const unit = typeof row.engineering_unit === 'string' && row.engineering_unit.trim()
        ? row.engineering_unit
        : typeof row.unit === 'string' && row.unit.trim()
          ? row.unit
          : 'kW';
      return {
        value,
        unit,
        quality: 'reported' as const,
        provenance: live ? 'live' as const : saved ? 'snapshot' as const : row.provenance === 'replay' ? 'replay' as const : undefined,
        status: live ? 'online' as const : 'stale' as const,
        sourceLabel: `${live ? 'Approved live' : saved ? 'Last saved approved' : 'Approved historical'} ${String(row.name ?? 'active power')} register · ${String(row.full_addr ?? row.addr ?? '—')}`,
        observedAt: saved ? savedSnapshotTime : telemetryDateTime(row).full,
        observationLabel: saved ? 'Saved snapshot' : 'Observed',
      };
    }
    const liveRawInput = rawFallbacks.acPower.inputs.find((input) => input.provenance === 'live');
    const rawInputRows = rawFallbacks.acPower.inputs.map(sourceRowForRawInput);
    const allRawInputsFresh = rawFallbacks.acPower.inputs.length > 0
      && rawFallbacks.acPower.inputs.every((input, index) => input.provenance === 'live' && isFreshSourceRow(rawInputRows[index]));
    const liveRawInputRow = sourceRowForRawInput(liveRawInput);
    if (liveRawInput && liveRawInputRow && isFreshSourceRow(liveRawInputRow) && !showingSavedRecord) {
      const isLiveInverterAggregate = rawFallbacks.acPower.method === 'inverter sum' && allRawInputsFresh;
      return {
        value: isLiveInverterAggregate ? rawFallbacks.acPower.value : liveRawInput.value,
        unit: liveRawInput.sourceUnit ?? 'raw',
        quality: liveRawInput.sourceReported ? 'reported' as const : 'raw' as const,
        provenance: 'live' as const,
        status: electricalLiveState === 'fresh' ? 'online' as const : 'stale' as const,
        sourceLabel: isLiveInverterAggregate
          ? `Live ${liveRawInput.sourceReported ? 'source-reported' : 'raw'} inverter aggregate · ${rawFallbacks.acPower.inputs.length} registers`
          : `Live ${liveRawInput.sourceReported ? 'source-reported' : 'raw'} ${liveRawInput.parameter} register · ${liveRawInput.address}`,
        observedAt: isLiveInverterAggregate ? observationRange(rawInputRows) : telemetryDateTime(liveRawInputRow).full,
        observationLabel: isLiveInverterAggregate ? 'Contributing timestamps' : 'Observed',
        inverterCount: isLiveInverterAggregate ? rawFallbacks.acPower.inputs.length : undefined,
      };
    }
    const liveInputs = rawFallbacks.acPower.inputs.length > 0 && rawFallbacks.acPower.inputs.every((input) => input.provenance === 'live');
    const rawInput = rawFallbacks.acPower.inputs[0];
    return {
      value: rawFallbacks.acPower.value,
      unit: rawFallbacks.acPower.unit,
      quality: rawFallbacks.acPower.value === null ? 'unavailable' as const : 'raw' as const,
      provenance: showingSavedRecord ? 'snapshot' as const : liveInputs ? 'live' as const : rawInput?.provenance,
      status: !showingSavedRecord && allRawInputsFresh && electricalLiveState === 'fresh' ? 'online' as const : rawFallbacks.acPower.value === null ? 'offline' as const : 'stale' as const,
      sourceLabel: showingSavedRecord ? `Last saved raw evidence · ${rawFallbacks.acPower.method}` : rawFallbacks.acPower.method,
      observedAt: showingSavedRecord ? savedSnapshotTime : observationRange(rawInputRows),
      observationLabel: showingSavedRecord ? 'Saved snapshot' : rawInputRows.length > 1 ? 'Contributing timestamps' : 'Observed',
      inverterCount: rawFallbacks.acPower.method === 'inverter sum' ? rawFallbacks.acPower.inputs.length : undefined,
    };
  }, [calculations.acPower, dashboardEvidenceRows, electricalLiveState, latestApprovedPlantPower, mode, now, onlinePowerReadings.length, rawFallbacks.acPower, savedKpiSnapshot, showingSavedRecord, totalAcPower, validatedInverterFleet]);
  const deviceCommunication = mode === 'demo'
    ? 'live'
    : communication?.deviceCommunication ?? (telemetryAge === null ? 'awaiting-first-data' : telemetryAge > DEVICE_STALE_MAX_AGE_MS ? 'interrupted' : telemetryAge > DEVICE_ONLINE_MAX_AGE_MS ? 'stale' : 'live');
  const telemetryLabel = mode === 'demo'
    ? 'Demo telemetry'
    : communication?.subscriptionState === 'pending'
      ? 'Broker connected · confirming telemetry topic'
      : communication?.subscriptionState === 'failed'
        ? 'Broker connected · telemetry topic unavailable'
        : `${communicationLabel(deviceCommunication)} device telemetry${connected ? '' : ' · broker reconnecting'}`;
  const brokerTransportLabel = mode === 'demo'
    ? 'Demo broker'
    : communication?.brokerTransport === 'subscribed'
      ? 'Topic subscribed'
      : communication?.brokerTransport === 'connected'
        ? 'Broker connected'
        : communication?.brokerTransport === 'standby'
          ? 'Standby consumer'
          : 'Disconnected';
  const connectionBadgeLabel = mode === 'demo'
    ? 'DEMO'
    : deviceCommunication === 'awaiting-first-data'
      ? 'WAITING'
      : deviceCommunication === 'interrupted'
        ? 'INTERRUPTED'
        : deviceCommunication.toUpperCase();
  const lastLiveDataTimestamp = communication?.lastReceivedAt
    ?? (lastTelemetryAt === null ? undefined : new Date(lastTelemetryAt).toISOString());
  const lastLiveDataLabel = lastLiveDataTimestamp
    ? formatInPlantTimezone(lastLiveDataTimestamp, persistence.timezone)
    : 'No live data received in this session';
  const liveDataUnavailableReason = error
    || communication?.activeInterruption?.reason
    || communication?.confirmedDeliveryGap?.reason
    || (communication?.subscriptionState === 'pending' ? 'The broker topic subscription is still being confirmed.' : undefined)
    || (communication?.subscriptionState === 'failed' ? 'The broker topic subscription failed.' : undefined)
    || (streamPhase === 'reconnecting' ? 'The live telemetry stream is reconnecting.' : undefined)
    || (deviceCommunication === 'stale' ? 'The last live device payload is stale.' : undefined)
    || (deviceCommunication === 'interrupted' ? 'Live device telemetry has stopped.' : undefined)
    || (!connected ? 'The live broker connection is unavailable.' : 'No live MQTT payload has been received yet.');
  const dashboardDataStatus = mode === 'demo'
    ? { title: 'Demo Data Available', detail: 'Demonstration values are not operational telemetry.', tone: 'border-blue-500/25 bg-blue-500/5 text-blue-300' }
    : electricalLiveState === 'fresh'
      ? { title: 'Live Data Available', detail: hasValidSavedSnapshot ? `Fresh MQTT evidence is active. Last Saved: ${lastSavedLabel}.` : 'Fresh MQTT evidence is active.', tone: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300' }
      : hasValidSavedSnapshot
        ? lastTelemetryAt === null
          ? {
              title: 'Last Saved Data',
               detail: `Live data unavailable: ${liveDataUnavailableReason} Last live data: ${lastLiveDataLabel}. Showing saved backend evidence from ${lastSavedLabel}.`,
              tone: 'border-blue-500/25 bg-blue-500/5 text-blue-300',
            }
          : {
              title: 'Live Data Temporarily Unavailable — Showing Last Saved',
               detail: `Live data unavailable: ${liveDataUnavailableReason} Last live data: ${lastLiveDataLabel}. Showing saved backend evidence from ${lastSavedLabel}.`,
              tone: 'border-amber-500/25 bg-amber-500/5 text-amber-300',
            }
        : { title: 'No Valid Data Available', detail: 'No fresh MQTT telemetry or successfully saved backend record is available for this dashboard.', tone: 'border-rose-500/25 bg-rose-500/5 text-rose-300' };
  const telemetryStatusTone = mode === 'demo' || (deviceCommunication === 'live' && connected)
    ? { container: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-400', dot: 'bg-emerald-400 pulse-soft' }
    : deviceCommunication === 'stale' || deviceCommunication === 'awaiting-first-data' || !connected
      ? { container: 'border-amber-500/25 bg-amber-500/5 text-amber-400', dot: 'bg-amber-400' }
      : { container: 'border-rose-500/25 bg-rose-500/5 text-rose-400', dot: 'bg-rose-400' };
  const dashboardFreshnessAge = communication?.freshnessAgeMs ?? telemetryAge ?? undefined;
  const dashboardSavedValue = savedKpiSnapshot
    ? lastSavedLabel
    : savedSnapshotLoadState === 'loading'
      ? 'Loading'
      : '—';
  const dashboardSavedDetail = savedKpiSnapshot
    ? `${savedKpiSnapshot.parameterCount} source parameter${savedKpiSnapshot.parameterCount === 1 ? '' : 's'} · confirmed dashboard record${persistenceResumeMessage(persistence.savingActive) ? ` · ${persistenceResumeMessage(persistence.savingActive)}` : ''}`
    : savedSnapshotLoadState === 'error'
      ? `Refresh failed; record protected${persistenceResumeMessage(persistence.savingActive) ? ` · ${persistenceResumeMessage(persistence.savingActive)}` : ''}`
      : `No confirmed backend record${persistenceResumeMessage(persistence.savingActive) ? ` · ${persistenceResumeMessage(persistence.savingActive)}` : ''}`;
  const dashboardFreshnessDetail = lastLiveDataTimestamp
    ? `Updated ${formatInPlantTimezone(lastLiveDataTimestamp, persistence.timezone)}`
    : 'Awaiting first live payload';
  const dashboardLiveStatusValue = mode === 'demo'
    ? 'Demo'
    : deviceCommunication === 'live' && connected
      ? 'Healthy'
      : communicationLabel(deviceCommunication);
  const dashboardLiveStatusDetail = mode === 'demo'
    ? 'Demonstration mode'
    : deviceCommunication === 'live' && connected
      ? 'MQTT and device telemetry active'
      : liveDataUnavailableReason;
  const dashboardSystemHealthy = mode === 'demo' || (!error && !persistence.error && deviceCommunication === 'live' && connected);
  const dashboardPersistenceResumeMessage = persistenceResumeMessage(persistence.savingActive);
  const dashboardSystemTitle = mode === 'demo'
    ? 'Demo monitoring mode'
    : dashboardPersistenceResumeMessage
      ? 'Live monitoring active'
    : dashboardSystemHealthy
      ? 'System operating normally'
      : 'System attention required';
  const dashboardSystemDetail = mode === 'demo'
    ? 'Demonstration values are not operational telemetry.'
    : dashboardPersistenceResumeMessage
      ? `Live telemetry remains active overnight. ${dashboardPersistenceResumeMessage}.`
    : dashboardSystemHealthy
      ? 'Live data is active and backend records are up to date.'
      : error || persistence.error || dashboardLiveStatusDetail;
  const dashboardNextSaveAt = persistence.nextScheduledAt ? Date.parse(persistence.nextScheduledAt) : Number.NaN;
  const dashboardNextSaveCountdown = persistenceNextSaveLabel(persistence.savingActive, persistence.nextScheduledAt, now, persistence.intervalMinutes, formatCountdown);
  const dashboardSourceValue = hasValidSavedSnapshot ? 'Saved' : 'Unavailable';
  const dashboardSourceDetail = hasValidSavedSnapshot
    ? `Dashboard record · ${lastSavedLabel}`
    : 'No successfully saved backend record';
  const dashboardKpiSourceLabel = showingSavedRecord
    ? `Saved record · ${lastSavedLabel}`
    : 'No saved backend record';
  const dashboardCommunicationSummary = mode === 'demo'
    ? 'Demo'
    : connected && deviceCommunication === 'live'
      ? 'Healthy'
      : !connected
        ? 'Reconnecting'
        : communicationLabel(deviceCommunication);

  return (
    <div className={`scada-theme ${theme === 'dark' ? 'dark' : 'light'} flex h-[100dvh] max-h-[100dvh] overflow-hidden bg-[#0b0f19] font-sans text-slate-200`}>
      {mobileNav && <button type="button" aria-label="Close navigation" data-testid="button-navigation-overlay" onClick={() => setMobileNav(false)} className="fixed inset-0 z-20 bg-black/40 backdrop-blur-[1px] md:hidden" />}
      <Sidebar onSettings={() => { setMobileNav(false); setSettingsOpen(true); }} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} activeSection={activeSection} onNavigate={navigateTo} collapsed={navigationCollapsed} onToggleCollapse={() => setNavigationCollapsed((current) => !current)} />
      
      <div className="scada-content-scroll flex h-full min-h-0 flex-1 min-w-0 flex-col overflow-hidden">
        <Header toggleMobileNav={() => setMobileNav(true)} mobileNav={mobileNav} connected={connected} connectionLabel={connectionBadgeLabel} mode={mode} theme={theme} onToggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} onRefresh={refreshTelemetry} onExport={exportTelemetry} onNotifications={() => navigateTo('alarms')} onSettings={() => setSettingsOpen(true)} now={now} weather={weatherState} siteName={plantSiteName} />
        
        <main className="scada-main-content min-h-0 min-w-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto overscroll-contain p-3 sm:p-6">
          {!scadaSession.loading && !scadaSession.authenticated && <ScadaCredentialLogin onSignedIn={() => setAuthRefreshToken((current) => current + 1)} />}
          {scadaSession.authenticated && scadaAccessState === 'unavailable' && <section className="grid min-h-[60vh] place-items-center rounded-2xl border border-dashed border-rose-500/30 bg-rose-500/[.04] p-8 text-center"><div className="max-w-md"><AlertCircle size={28} className="mx-auto mb-4 text-rose-400" /><h1 className="text-lg font-bold text-slate-100">SCADA access unavailable</h1><p className="mt-2 text-sm leading-6 text-slate-400">{siteAccessState.error}</p></div></section>}
          {scadaSession.authenticated && (scadaAccessState === 'denied' || (scadaAccessState === 'ready' && !plantSiteName)) && <section className="grid min-h-[60vh] place-items-center rounded-2xl border border-dashed border-amber-500/30 bg-amber-500/[.04] p-8 text-center"><div className="max-w-md"><MapPin size={28} className="mx-auto mb-4 text-amber-400" /><h1 className="text-lg font-bold text-slate-100">{inactiveAssignedSites.length ? 'Assigned site awaiting activation' : 'No SCADA site assigned'}</h1><p className="mt-2 text-sm leading-6 text-slate-400">{siteAccessState.error || (inactiveAssignedSites.length ? `${inactiveAssignedSites.join(', ')} is assigned to you, but live SCADA access remains blocked until a platform administrator completes a successful telemetry test and activates the site.` : 'Your account does not have an active site assignment. Ask a platform administrator to grant access before viewing live telemetry.')}</p></div></section>}
          {scadaSession.authenticated && scadaAccessState === 'ready' && plantSiteName && <><div className="scada-dashboard-site-bar mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-1.5 text-[10px]"><span className="font-medium text-slate-500">Assigned site</span><strong className="min-w-0 max-w-[min(42vw,18rem)] truncate text-blue-300">{plantSiteName}</strong><span className="scada-dashboard-site-status rounded-full border px-2 py-0.5 font-bold uppercase tracking-[0.12em]">Active</span>{siteAccessState.roles[plantSiteName] && <span className="truncate rounded-full border border-slate-700 px-2 py-0.5 uppercase tracking-[0.1em] text-slate-500">{siteAccessState.roles[plantSiteName]}</span>}</div>
          {activeSection !== 'overview' && <div id={activeSection} className="scroll-mt-6"><MonitorWorkspace section={activeSection} devices={inverterDisplayDevices} rows={currentLiveRows} mode={mode} liveState={electricalLiveState} persistence={persistence} calculations={calculations} savedSnapshot={dashboardSavedSnapshot} validatedFleet={validatedInverterFleet} rawPayload={rawPayload} rawJson={rawJson} rawTopic={rawTopic} rawPayloadSource={rawPayloadSource} onCopy={handleCopy} onOpenInverter={(device) => setSelectedInverterId(device.id)} onBack={() => navigateTo('overview')} onRefreshWeather={refreshWeather} onSiteChange={changeActiveSite} siteName={plantSiteName} sites={availableSites} weather={weatherState} now={now} energyStream={energyStream} lastLiveDataTimestamp={lastLiveDataTimestamp} /></div>}
          {activeSection === 'overview' && <>
          <section id="overview" data-section="overview" className="scroll-mt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div title="Current line frequency from the latest telemetry source.">
                <p className="text-xs font-medium text-slate-500">Dashboard <span className="px-1 text-slate-400">/</span> <span className="text-slate-300">Plant Overview</span></p>
                <h1 id="overview-heading" tabIndex={-1} className="mt-1 text-lg font-bold text-slate-100 focus:outline-none">Plant operations at a glance</h1>
              </div>
              <div role="status" data-testid="status-telemetry-connection" className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${telemetryStatusTone.container}`}>
                <span className={`h-2 w-2 rounded-full ${telemetryStatusTone.dot}`} />
                 {telemetryLabel}
                {!connected && <button type="button" onClick={refreshTelemetry} data-testid="button-retry-connection" className="ml-1 underline underline-offset-2 focus-ring">Retry</button>}
              </div>
            </div>
            {error && <div role="alert" data-testid="alert-telemetry-error" className="mb-4 flex flex-col items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/5 p-4 text-sm text-rose-400 sm:flex-row"><AlertCircle size={18} className="mt-0.5 shrink-0" /><div className="min-w-0 flex-1"><strong className="font-semibold">Telemetry needs attention.</strong><p className="mt-1 break-words text-rose-300">{error}</p></div><button type="button" onClick={refreshTelemetry} className="shrink-0 text-xs font-semibold underline focus-ring">Retry connection</button></div>}
              {mode === 'live' && <section className="scada-dashboard-status-grid mb-3" aria-label="Plant status summary">
                <article role="status" data-testid="status-dashboard-data-source" title={dashboardDataStatus.detail} className={`scada-dashboard-status-card ${dashboardDataStatus.tone}`}>
                  <span className="scada-dashboard-status-icon scada-dashboard-status-icon--radio"><Radio size={18} aria-hidden="true" /></span>
                  <div className="min-w-0"><p className="scada-dashboard-status-label">Data source</p><strong className="scada-dashboard-status-value">{dashboardSourceValue}</strong><p className="scada-dashboard-status-detail">{dashboardSourceDetail}</p></div>
                </article>
                <article data-testid="panel-saved-data" aria-label="Saved backend data" title={savedKpiSnapshot ? `Persisted ${formatInPlantTimezone(savedKpiSnapshot.capturedAt, savedKpiSnapshot.timezone ?? persistence.timezone)}. ${dashboardSavedDetail}.` : dashboardSavedDetail} className="scada-dashboard-status-card scada-dashboard-status-card--neutral">
                  <span className="scada-dashboard-status-icon scada-dashboard-status-icon--database"><Database size={18} aria-hidden="true" /></span>
                  <div className="min-w-0" data-testid="saved-data-status"><p className="scada-dashboard-status-label">Latest saved</p><strong className="scada-dashboard-status-value truncate">{dashboardSavedValue}</strong><p className="scada-dashboard-status-detail">{persistence.offlineQueuedSnapshots ? `Queued sync: ${persistence.offlineQueuedSnapshots}${dashboardPersistenceResumeMessage ? ` · ${dashboardPersistenceResumeMessage}` : ''}` : dashboardSavedDetail}</p></div>
                </article>
                <article title={`Freshness: ${formatElapsed(dashboardFreshnessAge)}. ${dashboardFreshnessDetail}.`} className="scada-dashboard-status-card scada-dashboard-status-card--freshness">
                  <span className="scada-dashboard-status-icon scada-dashboard-status-icon--clock"><Activity size={18} aria-hidden="true" /></span>
                  <div className="min-w-0"><p className="scada-dashboard-status-label">Data freshness</p><strong className="scada-dashboard-status-value">{formatElapsed(dashboardFreshnessAge)}</strong><p className="scada-dashboard-status-detail">{lastLiveDataTimestamp ? `Updated ${formatInPlantTimezone(lastLiveDataTimestamp, persistence.timezone)}` : 'Awaiting first payload'}</p></div>
                </article>
                <article title={dashboardLiveStatusDetail} className={`scada-dashboard-status-card ${dashboardSystemHealthy ? 'scada-dashboard-status-card--healthy' : 'scada-dashboard-status-card--attention'}`}>
                  <span className="scada-dashboard-status-icon scada-dashboard-status-icon--heartbeat"><Activity size={18} aria-hidden="true" /></span>
                  <div className="min-w-0"><p className="scada-dashboard-status-label">Live status</p><strong className="scada-dashboard-status-value">{dashboardLiveStatusValue}</strong><p className="scada-dashboard-status-detail">{dashboardSystemHealthy ? 'All systems normal' : dashboardLiveStatusDetail}</p></div>
                </article>
              </section>}
              <section data-testid="panel-live-communication" aria-label="Live communication health" className="scada-dashboard-communication-bar mb-3 rounded-xl border px-3 py-2.5">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5"><span className="scada-dashboard-compact-icon"><Wifi size={12} aria-hidden="true" /></span><h2 className="scada-dashboard-status-label">Communication health</h2><CustomBadge tone={communicationTone(deviceCommunication)}>{dashboardCommunicationSummary}</CustomBadge></div>
                  <details className="scada-dashboard-communication-details">
                    <summary>Details <ChevronRight size={13} aria-hidden="true" /></summary>
                    <div className="scada-dashboard-communication-detail-content">
                      <div className="scada-dashboard-communication-metrics">
                        <div title={`Broker: ${brokerTransportLabel}. Subscription: ${communication?.subscriptionState ?? 'unknown'}.`}><p>Broker</p><strong className={communication?.brokerTransport === 'subscribed' ? 'text-emerald-400' : communication?.brokerTransport === 'connected' ? 'text-blue-300' : 'text-amber-400'}>{brokerTransportLabel}</strong></div>
                        <div title={`Last received: ${formatInPlantTimezone(communication?.lastReceivedAt, persistence.timezone)}.`}><p>Last received</p><strong>{formatInPlantTimezone(communication?.lastReceivedAt, persistence.timezone)}</strong></div>
                        <div title="Median time between received telemetry messages."><p>Frequency</p><strong>{communication?.dataFrequencySeconds === undefined ? 'Learning' : communication.dataFrequencySeconds < 0.01 ? '<0.01s' : `${communication.dataFrequencySeconds}s`}</strong></div>
                        <div title="Age of the most recent received telemetry message."><p>Freshness</p><strong>{formatElapsed(dashboardFreshnessAge)}</strong></div>
                        <div title={`Source clock age: ${formatElapsed(communication?.sourceAgeMs)}. Last source timestamp: ${communication?.lastSourceTimestamp ?? 'unavailable'}.`}><p>Source age</p><strong>{formatElapsed(communication?.sourceAgeMs)}</strong></div>
                        <div title={`Received messages: ${communication?.receivedMessageCount?.toLocaleString() ?? '0'}. Last sequence: ${communication?.lastReceivedSequence ?? 'unavailable'}.`}><p>Messages</p><strong>{communication?.receivedMessageCount?.toLocaleString() ?? '0'}</strong></div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="scada-dashboard-compact-chip">SSE <strong>{streamPhase}</strong></span>
                        {recoveredEventCount > 0 && <span className="scada-dashboard-compact-chip scada-dashboard-compact-chip--blue">Recovered {recoveredEventCount}</span>}
                        {duplicateEventCount > 0 && <span className="scada-dashboard-compact-chip">Suppressed {duplicateEventCount}</span>}
                        {communication?.lastInterruption && !communication.activeInterruption && <span className="scada-dashboard-compact-chip">Last recovery · {formatElapsed(communication.lastInterruption.durationMs)}</span>}
                      </div>
                    </div>
                  </details>
                </div>
                {(communication?.confirmedDeliveryGap || communication?.activeInterruption || resyncNotice) && <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                  {communication?.confirmedDeliveryGap && <span role="status" className="scada-dashboard-compact-chip scada-dashboard-compact-chip--amber">Gap · {communication.confirmedDeliveryGap.reason}</span>}
                  {communication?.activeInterruption && <span role="status" className="scada-dashboard-compact-chip scada-dashboard-compact-chip--rose">Interrupted · {communication.activeInterruption.reason}</span>}
                  {resyncNotice && <span role="status" className="scada-dashboard-compact-chip scada-dashboard-compact-chip--amber">{resyncNotice}</span>}
                </div>}
              </section>
              {mode === 'live' && <section role="status" aria-label="System operation and persistence status" className={`scada-dashboard-system-strip mb-3 rounded-xl border ${dashboardSystemHealthy ? 'scada-dashboard-system-strip--healthy' : 'scada-dashboard-system-strip--attention'}`}>
                <div className="scada-dashboard-system-primary"><span className="scada-dashboard-system-icon"><Check size={17} aria-hidden="true" /></span><div className="min-w-0"><strong>{dashboardSystemTitle}</strong><p title={dashboardSystemDetail}>{dashboardSystemDetail}</p></div></div>
                <div className="scada-dashboard-system-metric" title={persistence.nextScheduledAt ? `${dashboardPersistenceResumeMessage ? `${dashboardPersistenceResumeMessage}. ` : ''}Next scheduled save: ${formatInPlantTimezone(persistence.nextScheduledAt, persistence.timezone)}.` : 'The next save window is not available.'}><span><RefreshCw size={15} aria-hidden="true" /></span><div><p>Next save in</p><strong>{dashboardNextSaveCountdown}</strong></div></div>
                <div className="scada-dashboard-system-metric" title={persistence.savingActive ? `Historical snapshots save every ${persistence.intervalMinutes} minutes.` : dashboardPersistenceResumeMessage ?? 'Historical saving is paused.'}><span><Database size={15} aria-hidden="true" /></span><div><p>Persistence</p><strong>{persistence.savingActive ? `Auto every ${persistence.intervalMinutes} min` : 'Saving paused'}</strong></div></div>
              </section>}
            <DashboardPowerFlow {...dashboardFlowReading} mode={mode} monitoringStatus={deviceCommunication} />
              <div className="scada-dashboard-kpis grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
              <KpiCard title="Total AC Power" value={mode === 'demo' ? totalAcPower?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? '—' : acPowerCard.value} unit={mode === 'demo' ? 'kW' : acPowerCard.unit} icon={Zap} footerIcon={Activity} tone="blue" subtext={mode === 'demo' ? 'Live plant output' : acPowerCard.value === 'Not reported' ? 'Output unavailable' : dashboardKpiSourceLabel} onClick={() => navigateTo('power')} help={`Total AC Power. ${acPowerCard.details}`} />
              <KpiCard title="Today's Energy" value={mode === 'demo' ? '14.13' : dailyEnergyCard.value} unit={mode === 'demo' ? 'MWh' : dailyEnergyCard.unit} icon={Sun} footerIcon={Sun} tone="amber" subtext={mode === 'demo' ? 'Day total' : dailyEnergyCard.value === 'Not reported' ? 'Energy unavailable' : dashboardKpiSourceLabel} onClick={() => navigateTo('energy')} help={`Today’s Energy. ${dailyEnergyCard.details}`} />
              <KpiCard title="Total Energy" value={mode === 'demo' ? '31,457.28' : totalEnergyCard.value} unit={mode === 'demo' ? 'kWh' : totalEnergyCard.unit} icon={Database} footerIcon={Database} tone="violet" subtext={mode === 'demo' ? 'Lifetime generation' : totalEnergyCard.value === 'Not reported' ? 'Lifetime data unavailable' : dashboardKpiSourceLabel} onClick={() => navigateTo('energy')} help={`Total Energy. ${totalEnergyCard.details}`} />
              <KpiCard title="Specific Yield" value={mode === 'demo' ? '4.62' : specificYieldCard.value} unit={mode === 'demo' ? 'kWh/kWp' : specificYieldCard.unit} icon={Activity} footerIcon={Activity} tone="green" subtext={mode === 'demo' ? 'Today' : specificYieldCard.value === 'Not reported' ? 'Performance unavailable' : dashboardKpiSourceLabel} onClick={() => navigateTo('power')} help={`Specific Yield. ${specificYieldCard.details}`} />
              <KpiCard title="Inverters Online" value={inverterCard.value} icon={Check} footerIcon={Check} tone={inverterCard.tone} variant="inverter" availability={inverterCard.availability} subtext={inverterCard.status} onClick={() => navigateTo('inverters')} help={inverterCard.help} />
              <KpiCard title="Active Alarms" value={activeAlarmCardCount.toString()} icon={AlertTriangle} footerIcon={activeAlarmCardCount ? AlertTriangle : Check} tone={activeAlarmCardCount ? 'red' : 'green'} variant="alarm" subtext={showingSavedRecord ? `Saved record · verify live` : activeAlarmCardCount ? 'Requires attention' : 'No active alarms'} onClick={() => navigateTo('alarms')} help={rawKpis.alarms ? `Active Alarms. Latest source alarm value: ${rawKpis.alarms.value}${rawKpis.alarms.sourceUnit ? ` ${rawKpis.alarms.sourceUnit}` : ''}.${showingSavedRecord ? ` Saved: ${lastSavedLabel}; current alarm state requires live telemetry.` : ''}` : 'Active Alarms. No alarm or fault evidence is currently reported.'} />
            </div>
          </section>
          
          <div id="electrical" data-section="electrical" className="min-w-0 scroll-mt-6">
            <ElectricalParametersChart rows={currentLiveRows} mode={mode} liveState={electricalLiveState} savedSnapshot={dashboardSavedSnapshot} siteName={plantSiteName} />
          </div>

              <div className="scada-dashboard-primary-grid grid grid-cols-1 gap-4 xl:grid-cols-[minmax(360px,1.2fr)_minmax(0,1.8fr)]">
            <div id="inverters" data-section="inverters" className="min-w-0 scroll-mt-6">
              <InverterOverviewTable devices={inverterDisplayDevices} rows={dashboardEvidenceRows} onOpenInverter={(device) => setSelectedInverterId(device.id)} onViewAll={() => navigateTo('inverters')} />
            </div>
            <div id="alarms" data-section="alarms" className="min-w-0 scroll-mt-6">
              <SidePanels devices={operationalDevices} rows={currentLiveRows} liveState={electricalLiveState} savedRows={showingSavedRecord ? savedSnapshotRows : []} savedLabel={showingSavedRecord ? lastSavedLabel : undefined} onOpenAlarms={() => navigateTo('alarms')} />
            </div>
          </div>
          
          <div className="scada-dashboard-analysis-grid grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              <div id="energy" data-section="energy" className="min-w-0 scroll-mt-6">
                <EnergySummaryChart mode={mode} dailyEnergy={calculations.dailyEnergy} rawFallback={rawFallbacks.dailyEnergy} savedLabel={showingSavedRecord ? lastSavedLabel : undefined} liveState={electricalLiveState} streamSamples={energyStream} now={now} />
             </div>
               <div id="power" data-section="power" className="min-w-0 scroll-mt-6 md:col-span-1 xl:col-span-2 2xl:col-span-3">
                <PowerTrendChart calculation={calculations.acPower} mode={mode} rawFallback={rawFallbacks.acPower} savedLabel={showingSavedRecord ? lastSavedLabel : undefined} />
             </div>
               <div className="min-w-0 md:col-span-2 xl:col-span-3 2xl:col-span-4">
                  <PowerDistributionChart inverters={mode === 'demo' ? inverters : []} rawInverters={rawKpis.inverters} rawInverterIdentities={rawInverterIdentitySignals(dashboardEvidenceRows)} validatedFleet={validatedInverterFleet} mode={mode} savedLabel={showingSavedRecord ? lastSavedLabel : undefined} onOpenInverter={(record) => setSelectedInverterId(sourceBackedInverterDevice(record, persistence.inverterEnergySite ?? plantSiteName ?? 'Discovered site').id)} />
            </div>
          </div>

           <EnvironmentDetails siteName={plantSiteName} sites={availableSites} weather={weatherState} now={now} onRefresh={refreshWeather} onSiteChange={changeActiveSite} />

          <DetailedLiveDataTable rows={currentLiveRows} persistence={persistence} lastReceivedAt={lastLiveDataTimestamp} />
          <SavedBackendDataPanel snapshot={dashboardSavedSnapshot} persistence={persistence} />

          <CompletePayloadInspector rawPayload={rawPayload} rawJson={rawJson} topic={rawTopic} source={rawPayloadSource} onCopy={handleCopy} />
          
          </>}
          </>}
        </main>
      </div>
       <BrokerPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} connected={connected} onConnect={connect} onDisconnect={disconnect} error={error} sites={availableSites} initialSite={plantSiteName} siteLocations={siteLocations} siteLocationError={siteLocationError} canManageCalibration={locationAdmin} calibrationProfile={calibrationProfile} calibrationProfileError={calibrationProfileError} onSaveCalibrationProfile={saveCalibrationProfile} onPreviewCalibrationProfile={previewCalibrationProfile} />
        {selectedInverter && (
          <Suspense fallback={<div role="status" className="fixed inset-0 z-50 grid place-items-center bg-[#0b0f19]/75 backdrop-blur-sm"><span className="rounded-lg border border-[#1E293B] bg-[#090B13] px-4 py-3 text-xs font-semibold text-slate-300">Loading inverter details…</span></div>}>
            <InverterDetailPanel device={selectedInverter} onClose={() => setSelectedInverterId(null)} siteName={selectedInverter.site} plantTimezone={persistence.timezone} mode={mode} now={now} weather={{ temperatureC: weatherState.data?.current.temperatureC, condition: weatherState.data?.current.weatherCondition, locationLabel: weatherState.data?.location.locationName ?? weatherState.location?.label }} />
          </Suspense>
        )}
      <Toaster />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <Switch>
          <Route path="/" component={AppShell} />
          <Route component={NotFound} />
        </Switch>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}

function useDeferredChartLibrary(enabled: boolean) {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const loadCharts = () => {
      chartsLoadPromise ??= import('recharts').then((charts) => {
        LineChart = charts.LineChart;
        Line = charts.Line;
        AreaChart = charts.AreaChart;
        Area = charts.Area;
        BarChart = charts.BarChart;
        Bar = charts.Bar;
        PieChart = charts.PieChart;
        Pie = charts.Pie;
        Cell = charts.Cell;
        XAxis = charts.XAxis;
        YAxis = charts.YAxis;
        CartesianGrid = charts.CartesianGrid;
        Tooltip = charts.Tooltip;
        ResponsiveContainer = charts.ResponsiveContainer;
      });
      void chartsLoadPromise.then(() => refresh((version) => version + 1));
    };
    const timer = window.setTimeout(loadCharts, 150);
    return () => window.clearTimeout(timer);
  }, [enabled]);
}

const EmptyChartElement = () => null;

let XAxis: typeof Recharts.XAxis = EmptyChartElement as unknown as typeof Recharts.XAxis;

let Cell: typeof Recharts.Cell = EmptyChartElement as typeof Recharts.Cell;

let Bar: typeof Recharts.Bar = EmptyChartElement as unknown as typeof Recharts.Bar;

let Tooltip: typeof Recharts.Tooltip = EmptyChartElement as unknown as typeof Recharts.Tooltip;

let CartesianGrid: typeof Recharts.CartesianGrid = EmptyChartElement as unknown as typeof Recharts.CartesianGrid;

let Line: typeof Recharts.Line = EmptyChartElement as unknown as typeof Recharts.Line;

let chartsLoadPromise: Promise<void> | null = null;

let LineChart: typeof Recharts.LineChart = ChartPlaceholder as typeof Recharts.LineChart;

let PieChart: typeof Recharts.PieChart = ChartPlaceholder as typeof Recharts.PieChart;

let YAxis: typeof Recharts.YAxis = EmptyChartElement as unknown as typeof Recharts.YAxis;

let ResponsiveContainer: typeof Recharts.ResponsiveContainer = ChartPlaceholder as typeof Recharts.ResponsiveContainer;

let Area: typeof Recharts.Area = EmptyChartElement as unknown as typeof Recharts.Area;

let BarChart: typeof Recharts.BarChart = ChartPlaceholder as typeof Recharts.BarChart;

let AreaChart: typeof Recharts.AreaChart = ChartPlaceholder as typeof Recharts.AreaChart;

let Pie: typeof Recharts.Pie = EmptyChartElement as unknown as typeof Recharts.Pie;
