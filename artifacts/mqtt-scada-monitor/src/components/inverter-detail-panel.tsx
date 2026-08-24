import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, CircleAlert,
  CloudSun, Cpu, Factory, Gauge, Info, MapPin, Power, Thermometer, X, Zap,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getFaultGuidance, normalizeFaults, telemetryText, type FaultEvidence } from '../fault-guidance';
import { buildPowerTrendSeries, countRawPowerSamples, getPowerTrendState, selectValidatedPowerSamples } from '../inverter-power-trend';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type DeviceStatus = 'online' | 'stale' | 'offline';
type SourceEvidence = {
  parameter: string;
  value: number;
  address: string;
  provenance: 'live' | 'retained' | 'recovered' | 'replay';
  sourceName?: string;
  observedAt?: string;
  unit?: string;
  semantic?: string;
  scalingStatus?: 'validated' | 'raw';
};
type Device = {
  id: string;
  name: string;
  site: string;
  type: string;
  status: DeviceStatus;
  lastSeen: number;
  telemetry: Record<string, JsonValue>;
  energyInverterId?: string;
  sourceEvidence?: SourceEvidence;
};
type WeatherContext = {
  temperatureC?: number | null;
  condition?: string | null;
  locationLabel?: string | null;
};
type Metric = {
  value: number | null;
  unit: string;
  source: string;
  quality: 'reported' | 'raw' | 'unavailable';
};
type EnergyRange = 'Day' | 'Week' | 'Month' | 'Year' | 'Lifetime';
type EnergyHistorySample = {
  id: number;
  siteName: string;
  siteScope: 'configured-source-site';
  inverterId: string;
  inverterName: string;
  parameter: string;
  value: number;
  rawValue: string;
  unit: string;
  address: string;
  sourceName: string;
  observedAt: string;
  receivedAt: string;
  scalingStatus: 'validated' | 'raw';
  sourcePayload: string;
};

type MeasurementSample = {
  id: number;
  siteName: string;
  inverterId: string;
  inverterName: string;
  parameter: string;
  displayLabel?: string;
  measurementKind: 'active-power' | 'dc-power' | 'energy' | 'electrical' | 'other';
  value: number;
  rawValue: string;
  unit: string;
  address: string;
  sourceName: string;
  observedAt: string;
  receivedAt: string;
  scalingStatus: 'validated' | 'raw';
  sourcePayload: string;
};

function asNumber(value: JsonValue | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function valueAt(source: Record<string, JsonValue>, path: string[]) {
  let value: JsonValue | undefined = source;
  for (const segment of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = value[segment];
  }
  return asNumber(value);
}

function matchingValue(value: JsonValue, keys: string[], depth = 0): { value: number; source: string } | null {
  if (depth > 6 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = matchingValue(item, keys, depth + 1);
      if (match) return match;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) {
      const numeric = asNumber(child);
      if (numeric !== null) return { value: numeric, source: key };
    }
  }
  for (const child of Object.values(value)) {
    const match = matchingValue(child, keys, depth + 1);
    if (match) return match;
  }
  return null;
}

function telemetryMetric(device: Device, paths: string[][], keys: string[], unit: string, allowRawSource = false): Metric {
  if (device.sourceEvidence && allowRawSource) {
    const verified = device.sourceEvidence.scalingStatus === 'validated';
    return {
      value: device.sourceEvidence.value,
      unit: verified ? device.sourceEvidence.unit ?? unit : 'raw',
      source: `${device.sourceEvidence.parameter} · ${device.sourceEvidence.address}`,
      quality: verified ? 'reported' : 'raw',
    };
  }
  for (const path of paths) {
    const value = valueAt(device.telemetry, path);
    if (value !== null) return { value, unit, source: path.join('.'), quality: 'reported' };
  }
  const matched = matchingValue(device.telemetry, keys);
  if (matched) return { value: matched.value, unit, source: matched.source, quality: 'reported' };
  return { value: null, unit, source: 'Not reported', quality: 'unavailable' };
}

function formatMetric(metric: Metric, fractionDigits = 1) {
  if (metric.value === null) return 'Data unavailable';
  return `${metric.value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits })}${metric.unit ? ` ${metric.unit}` : ''}`;
}

function formatRawValue(value: JsonValue) {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function flattenJson(value: JsonValue, path = ''): Array<{ path: string; value: string; type: string }> {
  if (!value || typeof value !== 'object') {
    return [{ path: path || 'payload', value: formatRawValue(value), type: value === null ? 'null' : typeof value }];
  }
  if (Array.isArray(value)) {
    if (!value.length) return [{ path: path || 'payload', value: '[]', type: 'array' }];
    return value.flatMap((item, index) => flattenJson(item, `${path}[${index}]`));
  }
  const entries = Object.entries(value);
  if (!entries.length) return [{ path: path || 'payload', value: '{}', type: 'object' }];
  return entries.flatMap(([key, child]) => flattenJson(child, path ? `${path}.${key}` : key));
}

function CustomBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'destructive' }) {
  const tones = {
    neutral: 'border-slate-700 bg-slate-800 text-slate-300',
    success: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400',
    warning: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
    destructive: 'border-rose-500/20 bg-rose-500/10 text-rose-400',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
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

function useModalAccessibility(onClose: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
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
  }, []);

  return dialogRef;
}

function FlowLabel({ label, metric, className }: { label: string; metric: Metric; className: string }) {
  return <div className={`absolute min-w-28 max-w-[45%] rounded-lg border border-[#1e293b] bg-[#111827]/95 px-2.5 py-2 text-center shadow-lg ${className}`}>
    <p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
    <p className={`mt-0.5 font-mono text-xs font-bold ${metric.value === null ? 'text-slate-500' : metric.quality === 'raw' ? 'text-amber-300' : 'text-slate-100'}`}>{formatMetric(metric)}</p>
  </div>;
}

function PowerFlow({ power, status }: { power: Metric; status: DeviceStatus }) {
  const isFlowing = power.value !== null && power.value > 0 && status === 'online' && power.quality !== 'raw';
  return (
      <section className="scada-power-flow relative overflow-hidden rounded-2xl border border-[#1E293B] bg-[radial-gradient(ellipse_at_top,rgba(255,92,0,.1),transparent_60%),#090B13] px-3 py-5 sm:px-6" data-testid="inverter-power-flow">
      <div className="pointer-events-none absolute inset-0 opacity-[0.15] [background-image:linear-gradient(rgba(255,255,255,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.1)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="relative mx-auto h-[330px] max-w-2xl sm:h-[350px]">
        <svg viewBox="0 0 720 380" role="img" aria-label="Solar power flow from array through selected inverter to grid export" className="h-full w-full">
          <defs>
            <linearGradient id="inverterFlowLine" x1="0%" x2="100%">
              <stop offset="0%" stopColor="#FF5C00" />
              <stop offset="100%" stopColor="#00E5FF" />
            </linearGradient>
            <filter id="inverterFlowGlow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <path d="M170 118 H304 Q328 118 328 144 V165" fill="none" className={isFlowing ? 'inverter-flow-path' : ''} stroke={isFlowing ? 'url(#inverterFlowLine)' : '#1E293B'} strokeDasharray={isFlowing ? '12 8' : undefined} strokeWidth="4" strokeLinecap="round" filter={isFlowing ? 'url(#inverterFlowGlow)' : undefined} />
          <path d="M392 165 V144 Q392 118 416 118 H554" fill="none" className={isFlowing ? 'inverter-flow-path inverter-flow-path-delayed' : ''} stroke={isFlowing ? 'url(#inverterFlowLine)' : '#1E293B'} strokeDasharray={isFlowing ? '12 8' : undefined} strokeWidth="4" strokeLinecap="round" filter={isFlowing ? 'url(#inverterFlowGlow)' : undefined} />
          <path d="M360 216 V257 H205" fill="none" stroke="#1E293B" strokeWidth="3" strokeLinecap="round" />
          <g transform="translate(66 65)">
            <polygon points="0,38 88,0 144,26 55,66" fill="#0F1322" stroke="#334155" strokeWidth="2" />
            <path d="M17 38 103 5M33 46 119 13M48 55 135 21M29 26 62 53M55 15 89 43M81 5 115 33" stroke="#475569" strokeWidth="1.5" opacity=".9" />
            <path d="M55 66 v35 M99 48 v53 M48 101 h58" stroke="#334155" strokeWidth="3" strokeLinecap="round" />
          </g>
          <g transform="translate(323 140)">
            <rect width="74" height="80" rx="11" fill="#090B13" stroke="#00E5FF" strokeWidth="2.5" filter="drop-shadow(0 0 8px rgba(0,229,255,0.3))" />
            <rect x="14" y="14" width="46" height="25" rx="4" fill="#0F1322" stroke="#1E293B" />
            <circle cx="37" cy="57" r="7" fill={isFlowing ? '#00F2A6' : '#334155'} filter={isFlowing ? 'drop-shadow(0 0 6px rgba(0,242,166,0.5))' : undefined} />
            <path d="M33 67 h8" stroke="#334155" strokeWidth="2" strokeLinecap="round" />
          </g>
          <g transform="translate(555 49)">
            <path d="M48 0 0 182h96L48 0Zm0 25 25 137H23L48 25Z" fill="#0F1322" stroke="#334155" strokeWidth="2" />
            <path d="M14 120h68M24 84h48M32 52h32M48 25v137M23 162l50-78M73 162 23 84" stroke="#475569" strokeWidth="2" />
            <path d="M-12 47h120M-1 47l-17 25M97 47l17 25" stroke="#334155" strokeWidth="3" strokeLinecap="round" />
            <rect x="17" y="186" width="62" height="12" rx="4" fill="#1E293B" />
          </g>
          <g transform="translate(132 237)">
            <path d="M0 42 54 0l54 42v62H0V42Z" fill="#090B13" stroke="#334155" strokeWidth="2" />
            <path d="M-8 42 54 -5l62 47" fill="none" stroke="#475569" strokeWidth="3" strokeLinecap="round" />
            <rect x="20" y="59" width="22" height="45" fill="#0F1322" stroke="#1E293B" />
            <rect x="65" y="59" width="20" height="18" fill="#FF5C00" opacity=".4" filter="drop-shadow(0 0 5px rgba(255,92,0,0.5))" />
          </g>
          <text x="112" y="160" fill="#94A3B8" fontSize="13" fontWeight="700" letterSpacing="2" textAnchor="middle">SOLAR ARRAY</text>
          <text x="360" y="247" fill="#00E5FF" fontSize="13" fontWeight="700" letterSpacing="2" textAnchor="middle">INVERTER</text>
          <text x="603" y="262" fill="#94A3B8" fontSize="13" fontWeight="700" letterSpacing="2" textAnchor="middle">GRID</text>
          <text x="186" y="365" fill="#64748B" fontSize="12" fontWeight="700" letterSpacing="2" textAnchor="middle">PLANT LOAD</text>
        </svg>
        <FlowLabel label="Source power" metric={power} className="left-[3%] top-[2%] sm:left-[6%]" />
        <FlowLabel label="Reported export" metric={power} className="right-[0%] top-[63%] sm:right-[4%]" />
         <div className="absolute bottom-0 left-1/2 max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-full border border-[#1E293B] bg-[#090B13]/90 px-4 py-2 text-center text-[10px] font-bold uppercase tracking-widest text-slate-400 backdrop-blur">
          {power.quality === 'raw' ? 'Raw source tag · scaling required' : power.value === null ? 'No reported power value' : isFlowing ? 'Reported power flow' : 'Flow paused until fresh inverter telemetry'}
        </div>
      </div>
    </section>
  );
}

function MetricCard({ icon: Icon, label, metric, detail }: { icon: typeof Zap; label: string; metric: Metric; detail: string }) {
  const unavailable = metric.value === null;
  const isRaw = metric.quality === 'raw';
  return <div className="scada-interactive-card group relative overflow-hidden rounded-xl border border-[#1E293B] bg-[#090B13] p-5 flex flex-col justify-between">
    <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
    <div className="flex items-start justify-between gap-3 relative z-10">
      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
      <div className={`p-1.5 rounded-lg border bg-opacity-10 ${unavailable ? 'bg-[#1E293B] border-[#1E293B] text-slate-600' : isRaw ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}>
        <Icon size={16} />
      </div>
    </div>
    <div className="mt-6 relative z-10">
      <p className={`font-mono text-3xl font-bold tracking-tighter ${unavailable ? 'text-slate-500' : isRaw ? 'text-amber-300' : 'text-slate-100'}`}>{formatMetric(metric, 2)}</p>
      <p className="mt-3 border-t border-[#1E293B]/70 pt-3 min-h-4 text-[10px] leading-relaxed text-slate-500 font-bold uppercase tracking-widest">{unavailable ? 'Not reported' : isRaw ? `${metric.source} · scaling required` : `${detail} · ${metric.source}`}</p>
    </div>
  </div>;
}

function FaultEvidenceList({ title, items, deviceModel, emptyMessage }: { title: string; items: FaultEvidence[]; deviceModel: string | null; emptyMessage: string }) {
  return <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5">
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</p><h3 className="mt-1 text-sm font-bold text-slate-100">{items.length ? `${items.length} reported ${title.toLowerCase().slice(0, -1)}${items.length === 1 ? '' : 's'}` : `No active ${title.toLowerCase()} reported`}</h3></div>
      <CircleAlert size={20} className={items.length ? 'text-rose-400' : 'text-emerald-400'} />
    </div>
    {items.length ? <div className="mt-4 space-y-2">{items.map((item) => {
      const guidance = getFaultGuidance(item, deviceModel ?? undefined);
      const mappingLabel = guidance.mapping === 'source-reported' ? 'Source reason' : guidance.mapping === 'reference-mapped' ? 'Reference mapping' : 'Reason not mapped';
      return <details key={item.id} className="group rounded-xl border border-rose-500/20 bg-rose-500/[0.04]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 marker:content-none focus-ring"><div className="min-w-0"><p className="truncate text-xs font-bold text-rose-200">{guidance.title}</p><p className="mt-1 truncate font-mono text-[10px] text-rose-200/70">{item.code ? `Code ${item.code}` : 'No code reported'} · {item.source}</p></div><span className="shrink-0 text-[10px] font-semibold text-rose-300 group-open:hidden">Details</span><span className="hidden shrink-0 text-[10px] font-semibold text-rose-300 group-open:inline">Hide</span></summary>
        <div className="border-t border-rose-500/15 px-3 py-3 text-xs leading-5 text-slate-300">
          <dl className="grid gap-2 sm:grid-cols-2"><div><dt className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Alarm source</dt><dd className="mt-0.5 break-words">{item.source}</dd></div><div><dt className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Observed</dt><dd className="mt-0.5 break-words">{item.observedAt ?? 'Not reported'}</dd></div><div className="sm:col-span-2"><dt className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Fault reason</dt><dd className="mt-0.5">{guidance.reason}</dd></div></dl>
          <div className="mt-3 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] px-3 py-2"><p className="text-[9px] font-bold uppercase tracking-wider text-amber-300">{mappingLabel}</p><p className="mt-1 text-[10px] leading-4 text-amber-100/70">{guidance.scope}</p></div>
          <div className="mt-3"><p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">Operator suggestions</p><ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] leading-5 text-slate-300">{guidance.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ol></div>
          <details className="mt-3 rounded-lg bg-[#0b0f19]"><summary className="cursor-pointer px-2.5 py-2 text-[10px] font-semibold text-slate-400">Source evidence</summary><p className="break-all border-t border-[#1e293b] px-2.5 py-2 font-mono text-[10px] text-slate-400">{item.rawValue}</p></details>
        </div>
      </details>;
    })}</div> : <p className="mt-4 text-xs leading-5 text-slate-500">{emptyMessage}</p>}
  </section>;
}

function dateLabel(date: Date) {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function dateKeyInTimezone(now: number, timezone?: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function calendarDateFromKey(key: string) {
  return new Date(`${key}T12:00:00.000Z`);
}

function offsetCalendarDate(key: string, range: EnergyRange, offset: number) {
  const date = calendarDateFromKey(key);
  if (range === 'Day') date.setUTCDate(date.getUTCDate() + offset);
  if (range === 'Week') date.setUTCDate(date.getUTCDate() + offset * 7);
  if (range === 'Month') date.setUTCMonth(date.getUTCMonth() + offset);
  if (range === 'Year') date.setUTCFullYear(date.getUTCFullYear() + offset);
  return date.toISOString().slice(0, 10);
}

function energyRangeBounds(range: Exclude<EnergyRange, 'Lifetime'>, selectedDate: Date) {
  const start = new Date(selectedDate);
  if (range === 'Day') {
    start.setHours(0, 0, 0, 0);
  } else if (range === 'Week') {
    start.setHours(0, 0, 0, 0);
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
  } else if (range === 'Month') {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }
  const end = new Date(start);
  if (range === 'Day') end.setDate(end.getDate() + 1);
  if (range === 'Week') end.setDate(end.getDate() + 7);
  if (range === 'Month') end.setMonth(end.getMonth() + 1);
  if (range === 'Year') end.setFullYear(end.getFullYear() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { from: start, to: end };
}

function energyRangeLabel(range: EnergyRange, selectedDate: Date) {
  if (range === 'Lifetime') return 'Lifetime device record';
  const bounds = energyRangeBounds(range, selectedDate);
  if (range === 'Day') return dateLabel(selectedDate);
  return `${dateLabel(bounds.from)} — ${dateLabel(new Date(bounds.to.getTime() - 1))}`;
}

function validEnergyHistory(value: unknown): EnergyHistorySample[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const sample = item as Record<string, unknown>;
    const id = typeof sample.id === 'number' ? sample.id : Number(sample.id);
    const numeric = typeof sample.value === 'number' ? sample.value : Number(sample.value);
    if (!Number.isInteger(id) || !Number.isFinite(numeric) || typeof sample.observedAt !== 'string' || typeof sample.parameter !== 'string') return [];
    return [{
      id,
      siteName: typeof sample.siteName === 'string' ? sample.siteName : 'Selected site',
      siteScope: 'configured-source-site',
      inverterId: typeof sample.inverterId === 'string' ? sample.inverterId : '',
      inverterName: typeof sample.inverterName === 'string' ? sample.inverterName : 'Selected inverter',
      parameter: sample.parameter,
      value: numeric,
      rawValue: typeof sample.rawValue === 'string' ? sample.rawValue : String(sample.value),
      unit: typeof sample.unit === 'string' ? sample.unit : 'source units',
      address: typeof sample.address === 'string' ? sample.address : '—',
      sourceName: typeof sample.sourceName === 'string' ? sample.sourceName : 'MQTT source',
      observedAt: sample.observedAt,
      receivedAt: typeof sample.receivedAt === 'string' ? sample.receivedAt : sample.observedAt,
      scalingStatus: sample.scalingStatus === 'validated' ? 'validated' : 'raw',
      sourcePayload: typeof sample.sourcePayload === 'string' ? sample.sourcePayload : '',
    } satisfies EnergyHistorySample];
  });
}

function validMeasurements(value: unknown): MeasurementSample[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const sample = item as Record<string, unknown>;
    const id = typeof sample.id === 'number' ? sample.id : Number(sample.id);
    const numeric = typeof sample.value === 'number' ? sample.value : Number(sample.value);
    if (!Number.isInteger(id) || !Number.isFinite(numeric) || typeof sample.observedAt !== 'string' || typeof sample.parameter !== 'string') return [];
    return [{
      id,
      siteName: typeof sample.siteName === 'string' ? sample.siteName : 'Selected site',
      inverterId: typeof sample.inverterId === 'string' ? sample.inverterId : '',
      inverterName: typeof sample.inverterName === 'string' ? sample.inverterName : 'Selected inverter',
      parameter: sample.parameter,
      displayLabel: typeof sample.displayLabel === 'string' ? sample.displayLabel : undefined,
      measurementKind: ['active-power', 'dc-power', 'energy', 'electrical', 'other'].includes(sample.measurementKind as string) ? sample.measurementKind as any : 'other',
      value: numeric,
      rawValue: typeof sample.rawValue === 'string' ? sample.rawValue : String(sample.value),
      unit: typeof sample.unit === 'string' ? sample.unit : '',
      address: typeof sample.address === 'string' ? sample.address : '—',
      sourceName: typeof sample.sourceName === 'string' ? sample.sourceName : 'MQTT source',
      observedAt: sample.observedAt,
      receivedAt: typeof sample.receivedAt === 'string' ? sample.receivedAt : sample.observedAt,
      scalingStatus: sample.scalingStatus === 'validated' ? 'validated' : 'raw',
      sourcePayload: typeof sample.sourcePayload === 'string' ? sample.sourcePayload : '',
    }];
  });
}

export default function InverterDetailPanel({ device, onClose, weather, siteName, plantTimezone, mode = 'live', now = Date.now() }: { device: Device; onClose: () => void; weather?: WeatherContext; siteName: string; plantTimezone?: string; mode?: 'demo' | 'live'; now?: number }) {
  const [tab, setTab] = useState<'Overview' | 'Device'>('Overview');
  const [range, setRange] = useState<EnergyRange>('Day');
  const [dateOffset, setDateOffset] = useState(0);
  const [energyHistory, setEnergyHistory] = useState<EnergyHistorySample[]>([]);
  const [energyHistoryState, setEnergyHistoryState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' });
  const [measurements, setMeasurements] = useState<MeasurementSample[]>([]);
  const [measurementsState, setMeasurementsState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' });
  const dialogRef = useModalAccessibility(onClose);

  useEffect(() => {
    setTab('Overview');
    setRange('Day');
    setDateOffset(0);
  }, [device.id]);

  const plantToday = dateKeyInTimezone(now, plantTimezone);
  const selectedDateKey = useMemo(() => offsetCalendarDate(plantToday, range, dateOffset), [dateOffset, plantToday, range]);
  const selectedDate = useMemo(() => calendarDateFromKey(selectedDateKey), [selectedDateKey]);
  const selectedHistoryBounds = useMemo(
    () => range === 'Lifetime' ? null : energyRangeBounds(range, selectedDate),
    [dateOffset, range, selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()],
  );

  useEffect(() => {
    if (mode !== 'live' || !selectedHistoryBounds) {
      setEnergyHistory([]);
      setEnergyHistoryState({ loading: false, error: '' });
      return;
    }
    const controller = new AbortController();
    const loadEnergyHistory = async () => {
      setEnergyHistoryState({ loading: true, error: '' });
      try {
        const params = new URLSearchParams({
          siteName,
          inverterId: device.energyInverterId ?? device.id,
          period: range,
          anchor: selectedDateKey,
        });
        const response = await fetch(`/api/mqtt/inverter-energy-history?${params.toString()}`, { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { samples?: unknown[]; message?: string };
        if (!response.ok) throw new Error(payload.message ?? 'Unable to load per-inverter energy history.');
        setEnergyHistory(validEnergyHistory(payload.samples));
        setEnergyHistoryState({ loading: false, error: '' });
      } catch (error) {
        if (controller.signal.aborted) return;
        setEnergyHistory([]);
        setEnergyHistoryState({ loading: false, error: error instanceof Error ? error.message : 'Unable to load per-inverter energy history.' });
      }
    };
    void loadEnergyHistory();
    return () => controller.abort();
  }, [device.energyInverterId, device.id, mode, range, selectedDateKey, selectedHistoryBounds?.from.getTime(), selectedHistoryBounds?.to.getTime(), siteName]);

  useEffect(() => {
    if (mode !== 'live' || !selectedHistoryBounds) {
      if (mode === 'demo' && selectedHistoryBounds) {
        const rawPower = matchingValue(device.telemetry, ['activekw', 'activepower', 'powerkw', 'realpowerkw', 'outputpowerkw']);
        const powerValue = rawPower?.value ?? 65.5;
        const nowMs = Date.now();
        const samples: MeasurementSample[] = [];
        const periodMs = selectedHistoryBounds.to.getTime() - selectedHistoryBounds.from.getTime();
        const step = periodMs / 24; 
        for (let i = 0; i <= 24; i++) {
          const time = new Date(selectedHistoryBounds.from.getTime() + step * i);
          if (time.getTime() > nowMs && range === 'Day') break;
          const hour = time.getUTCHours();
          const sunlight = Math.max(0, Math.sin((hour - 6) * Math.PI / 12));
          samples.push({
            id: i,
            siteName: siteName,
            inverterId: device.id,
            inverterName: device.name,
            parameter: 'demo_active_power',
            displayLabel: 'Demo Active Power',
            measurementKind: 'active-power',
            value: powerValue * sunlight * (0.8 + 0.4 * (Math.sin(i) / 2 + 0.5)),
            rawValue: String(powerValue * sunlight),
            unit: 'kW',
            address: '0xDEMO',
            sourceName: 'Demo Stream',
            observedAt: time.toISOString(),
            receivedAt: time.toISOString(),
            scalingStatus: 'validated',
            sourcePayload: '{}'
          });
        }
        setMeasurements(samples);
        setMeasurementsState({ loading: false, error: '' });
      } else {
        setMeasurements([]);
        setMeasurementsState({ loading: false, error: '' });
      }
      return;
    }
    const controller = new AbortController();
    const loadMeasurements = async () => {
      setMeasurementsState({ loading: true, error: '' });
      try {
        const params = new URLSearchParams({
          siteName,
          inverterId: device.id,
          period: range,
          anchor: selectedDateKey,
        });
        const response = await fetch(`/api/mqtt/inverter-measurements?${params.toString()}`, { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { samples?: unknown[]; message?: string };
        if (!response.ok) throw new Error(payload.message ?? 'Unable to load inverter measurements.');
        setMeasurements(validMeasurements(payload.samples));
        setMeasurementsState({ loading: false, error: '' });
      } catch (error) {
        if (controller.signal.aborted) return;
        setMeasurements([]);
        setMeasurementsState({ loading: false, error: error instanceof Error ? error.message : 'Unable to load inverter measurements.' });
      }
    };
    void loadMeasurements();
    return () => controller.abort();
  }, [device.id, device.name, device.telemetry, mode, range, selectedDateKey, selectedHistoryBounds, siteName]);

  const metrics = useMemo(() => ({
    power: telemetryMetric(device, [['power', 'active_kw'], ['power', 'activePower'], ['ac', 'active_kw']], ['activekw', 'activepower', 'powerkw', 'realpowerkw', 'outputpowerkw'], 'kW', true),
    capacity: telemetryMetric(device, [['capacity', 'installed_mwp'], ['capacity', 'installed_kw'], ['power', 'rated_kw']], ['installedpowermwp', 'installedcapacitymwp', 'ratedpowerkw', 'ratedcapacitykw', 'installedpowerkw'], ''),
    dailyEnergy: telemetryMetric(device, [['energy', 'daily_mwh'], ['energy', 'daily_kwh'], ['energy', 'today_kwh']], ['dailyenergymwh', 'dailyenergykwh', 'todayenergykwh', 'todaygenerationkwh'], ''),
    lifetimeEnergy: telemetryMetric(device, [['energy', 'total_kwh'], ['energy', 'lifetime_kwh']], ['totalenergykwh', 'lifetimeenergykwh', 'totalgenerationkwh'], 'kWh'),
    voltage: telemetryMetric(device, [['dc_bus', 'voltage_v'], ['dc', 'voltage_v']], ['dcbusvoltagev', 'dcvoltagev', 'voltagev'], 'V'),
    current: telemetryMetric(device, [['dc_bus', 'current_a'], ['dc', 'current_a']], ['dcbuscurrenta', 'dccurrenta', 'currenta'], 'A'),
    cabinetTemp: telemetryMetric(device, [['temperature', 'cabinet_c']], ['cabinettemperaturec', 'cabinettemp', 'cabinetc'], '°C'),
    heatsinkTemp: telemetryMetric(device, [['temperature', 'heatsink_c']], ['heatsinktemperaturec', 'heatsinktemp', 'heatsinkc'], '°C'),
    efficiency: telemetryMetric(device, [['power', 'efficiency']], ['efficiency', 'efficiencypct'], '%'),
    reactive: telemetryMetric(device, [['power', 'reactive_kvar']], ['reactivekvar', 'reactivepowerkvar'], 'kVAr'),
  }), [device]);
  const rawRows = useMemo(() => flattenJson(device.telemetry), [device.telemetry]);
  const alarms = Array.isArray(device.telemetry.alarms) ? device.telemetry.alarms : null;
  const faults = Array.isArray(device.telemetry.faults) ? device.telemetry.faults : null;
  const alarmEvidence = useMemo(() => normalizeFaults(device.telemetry.alarms, 'alarm'), [device.telemetry.alarms]);
  const faultEvidence = useMemo(() => normalizeFaults(device.telemetry.faults), [device.telemetry.faults]);
  const deviceModel = telemetryText(device.telemetry, ['model', 'deviceModel', 'device_model', 'modelName']);
  const firmware = typeof device.telemetry.firmware === 'string' ? device.telemetry.firmware : null;
  const validatedSource = device.sourceEvidence?.scalingStatus === 'validated';
  const statusLabel = validatedSource ? 'Validated live source' : device.sourceEvidence ? 'Source tag' : device.status === 'online' ? 'Reporting' : device.status === 'stale' ? 'Telemetry stale' : 'Not reporting';
  const statusTone = validatedSource ? 'success' : device.sourceEvidence ? 'warning' : device.status === 'online' ? 'success' : device.status === 'offline' ? 'destructive' : 'warning';
  const validatedEnergyHistory = energyHistory.filter((sample) => sample.scalingStatus === 'validated');
  const latestEnergySample = validatedEnergyHistory.at(-1);
  const energyMetric = range === 'Lifetime'
    ? metrics.lifetimeEnergy
    : latestEnergySample
      ? { value: latestEnergySample.value, unit: latestEnergySample.unit, source: `${latestEnergySample.parameter} · ${latestEnergySample.address}`, quality: 'reported' as const }
      : { value: null, unit: '', source: 'No validated per-inverter time series reported', quality: 'unavailable' as const };
  const energyUnit = range === 'Lifetime'
    ? metrics.lifetimeEnergy.value === null ? 'No lifetime energy telemetry' : 'Device-reported lifetime energy'
    : latestEnergySample?.unit ?? (energyHistory.length ? 'source units' : 'No energy series');
  const chartData = validatedEnergyHistory.map((sample) => ({
    time: new Date(sample.observedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    value: sample.value,
  }));
  const rawEnergyCount = energyHistory.length - validatedEnergyHistory.length;
  const rawTimestamp = new Date(device.lastSeen);
  const lastSeen = Number.isFinite(rawTimestamp.getTime()) ? rawTimestamp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : 'Timestamp unavailable';

  const validatedPowerSamples = selectValidatedPowerSamples(measurements);
  const rawPowerCount = countRawPowerSamples(measurements);
  
  const powerChartData = useMemo(() => {
    return buildPowerTrendSeries(validatedPowerSamples);
  }, [validatedPowerSamples]);
  
  const hasAcPower = powerChartData.some(d => d.ac !== undefined);
  const hasDcPower = powerChartData.some(d => d.dc !== undefined);
  const powerEvidenceSamples = measurements.filter((sample) => sample.measurementKind === 'active-power' || sample.measurementKind === 'dc-power');
  const powerSourceLabels = Array.from(new Set(powerEvidenceSamples.map((sample) => `${sample.sourceName} · ${sample.address}`)));
  const powerParameterLabels = Array.from(new Set(powerEvidenceSamples.map((sample) => sample.displayLabel || sample.parameter)));
  const powerTrendState = getPowerTrendState(measurements, measurementsState.loading);

  const newestArchivedParameters = useMemo(() => {
    const params = new Map<string, MeasurementSample>();
    const sorted = [...measurements].sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
    for (const sample of sorted) {
      params.set(sample.parameter, sample);
    }
    return Array.from(params.values()).sort((a, b) => a.parameter.localeCompare(b.parameter));
  }, [measurements]);

  return (
    <>
      <button type="button" aria-label="Close inverter details" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-[#0b0f19]/75 backdrop-blur-sm" />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${device.name} monitoring details`} tabIndex={-1} className="scada-inverter-detail-dialog fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-[#111827] shadow-2xl sm:inset-y-3 sm:rounded-2xl lg:inset-y-4 lg:left-auto lg:right-0 lg:w-[min(1040px,calc(100vw-2rem))]">
        <header className="shrink-0 border-b border-[#1e293b] bg-[#111827]/95 px-4 py-3 backdrop-blur sm:px-6 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button type="button" onClick={onClose} aria-label="Back to inverter fleet" data-testid="button-back-inverter-fleet" title="Back to inverter fleet" className="rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring"><ArrowLeft size={20} /></button>
              <div className="min-w-0">
                <p className="break-words text-[10px] font-bold uppercase tracking-[0.16em] text-orange-400">Inverter fleet · {device.site}</p>
                <h2 className="mt-0.5 break-words text-base font-bold text-slate-100 sm:text-lg">{device.name}</h2>
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close inverter details" data-testid="button-close-inverter-details" title="Close inverter details" className="rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring"><X size={20} /></button>
          </div>
          <div className="mt-4 grid grid-cols-2 border-t border-[#1e293b] pt-3 text-sm font-medium sm:max-w-sm">
            {(['Overview', 'Device'] as const).map((item) => <button key={item} type="button" onClick={() => setTab(item)} aria-pressed={tab === item} data-testid={`button-inverter-tab-${item.toLowerCase()}`} className={`relative px-3 py-2.5 focus-ring ${tab === item ? 'text-orange-400' : 'text-slate-500 hover:text-slate-200'}`}>{item}{tab === item && <span className="absolute inset-x-8 bottom-0 h-0.5 rounded-full bg-orange-400" />}</button>)}
          </div>
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#0b0f19] p-4 sm:p-6">
          {tab === 'Overview' ? <div className="mx-auto max-w-5xl space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CustomBadge tone={statusTone}><span className={`h-1.5 w-1.5 rounded-full ${statusTone === 'success' ? 'bg-emerald-400 pulse-soft' : statusTone === 'destructive' ? 'bg-rose-400' : 'bg-amber-400'}`} />{statusLabel}</CustomBadge>
                <div className="flex min-w-0 items-start gap-2 text-xs text-slate-400" title={weather?.locationLabel ?? undefined}><CloudSun size={15} className="mt-0.5 shrink-0 text-blue-300" /><span className="break-words text-right">{weather?.condition ?? 'Weather not reported'}{weather?.temperatureC !== null && weather?.temperatureC !== undefined ? ` · ${weather.temperatureC.toFixed(1)}°C` : ''}</span></div>
            </div>

            <PowerFlow power={metrics.power} status={device.status} />

            <div className="grid grid-cols-1 divide-y divide-[#1e293b] overflow-hidden rounded-2xl border border-[#1e293b] bg-[#111827] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
               <div className="p-4 sm:p-5"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><Power size={15} className="text-orange-400" />Real-time power</div><p data-testid="inverter-real-time-power" className={`mt-3 font-mono text-3xl font-bold ${metrics.power.value === null ? 'text-slate-500' : metrics.power.quality === 'raw' ? 'text-amber-300' : 'text-slate-100'}`}>{formatMetric(metrics.power, 2)}</p><p className="mt-2 text-[10px] leading-4 text-slate-500">{metrics.power.quality === 'raw' ? 'Source tag only · engineering scaling required' : metrics.power.value === null ? 'This inverter has not reported active power.' : validatedSource ? `Validated active power · ${device.sourceEvidence?.semantic ?? 'approved semantic'} · ${device.sourceEvidence?.observedAt ?? 'source time unavailable'}` : `Reported by ${metrics.power.source}`}</p></div>
              <div className="p-4 sm:p-5"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><Gauge size={15} className="text-orange-400" />Installed power</div><p data-testid="inverter-installed-power" className={`mt-3 font-mono text-3xl font-bold ${metrics.capacity.value === null ? 'text-slate-500' : 'text-slate-100'}`}>{formatMetric(metrics.capacity, 2)}</p><p className="mt-2 text-[10px] leading-4 text-slate-500">{metrics.capacity.value === null ? 'Not reported by this inverter.' : `Reported by ${metrics.capacity.source}`}</p></div>
            </div>

            {/* Shared History Controls */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div role="tablist" aria-label="Inverter history period" className="scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto rounded-full bg-[#0b0f19] p-1 border border-[#1e293b]">
                {(['Day', 'Week', 'Month', 'Year', 'Lifetime'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={range === item} onClick={() => { setRange(item); setDateOffset(0); }} data-testid={`button-inverter-range-${item.toLowerCase()}`} className={`rounded-full px-3 py-2 text-xs font-semibold focus-ring transition-colors ${range === item ? 'bg-orange-500/15 text-orange-300' : 'text-slate-500 hover:bg-[#1e293b] hover:text-slate-200'}`}>{item}</button>)}
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-[#1e293b] bg-[#0f1423] px-3 py-2 sm:min-w-[320px]">
                <button type="button" disabled={range === 'Lifetime'} onClick={() => setDateOffset((offset) => offset - 1)} aria-label="Previous period" title={range === 'Lifetime' ? 'Lifetime history has no date navigation' : 'Previous period'} className="rounded-md p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600 transition-colors"><ChevronLeft size={18} /></button>
                <div className="min-w-0 flex-1 flex items-center justify-center gap-2 text-center text-sm font-semibold text-slate-200"><CalendarDays size={15} className="shrink-0 text-slate-500" /><span className="break-words">{energyRangeLabel(range, selectedDate)}</span></div>
                <button type="button" disabled={range === 'Lifetime' || dateOffset >= 0} onClick={() => setDateOffset((offset) => offset + 1)} aria-label="Next period" title={range === 'Lifetime' ? 'Lifetime history has no date navigation' : dateOffset >= 0 ? 'Future history is unavailable' : 'Next period'} className="rounded-md p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600 transition-colors"><ChevronRight size={18} /></button>
              </div>
            </div>

            <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5" data-testid="inverter-power-trend">
              <div className="border-b border-[#1e293b] pb-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><h3 className="text-base font-bold text-slate-100">Power generation trend</h3><p className="mt-1 text-xs text-slate-500">Selected inverter only · validated AC and explicitly reported DC power.</p></div>
                  <CustomBadge tone={powerTrendState === 'validated' ? 'success' : powerTrendState === 'raw-only' ? 'warning' : 'neutral'}>{powerTrendState === 'validated' ? 'Validated history' : powerTrendState === 'raw-only' ? 'Raw only' : powerTrendState === 'loading' ? 'Loading' : 'No history'}</CustomBadge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
                  <span className="rounded-md border border-[#1e293b] bg-[#0f1423] px-2 py-1"><strong className="font-semibold text-slate-300">Range:</strong> {energyRangeLabel(range, selectedDate)}</span>
                  {powerSourceLabels.length > 0 && <span className="min-w-0 max-w-full break-words rounded-md border border-[#1e293b] bg-[#0f1423] px-2 py-1"><strong className="font-semibold text-slate-300">Source:</strong> {powerSourceLabels.join(' · ')}</span>}
                  {powerParameterLabels.length > 0 && <span className="min-w-0 max-w-full break-words rounded-md border border-[#1e293b] bg-[#0f1423] px-2 py-1"><strong className="font-semibold text-slate-300">Signals:</strong> {powerParameterLabels.join(', ')}</span>}
                </div>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-end">
                <div>
                  <p className="text-xs font-semibold text-blue-300">Peak Reported Power</p>
                  <p data-testid="inverter-power-trend-value" className={`mt-2 font-mono text-4xl font-bold tracking-tight ${!hasAcPower ? 'text-slate-500' : 'text-blue-400'}`}>
                    {hasAcPower ? `${Math.max(...powerChartData.map(d => d.ac ?? 0)).toLocaleString()} kW` : '—'}
                  </p>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">
                    {measurementsState.loading ? 'Loading power history…' : rawPowerCount ? `${rawPowerCount} raw power source sample${rawPowerCount === 1 ? '' : 's'} found; scaling required.` : powerChartData.length === 0 ? 'No per-inverter power samples available.' : 'Reported peak in period.'}
                  </p>
                </div>
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-[#334155] bg-[#0b0f19] px-3 text-center text-xs leading-5 text-slate-500" aria-label={powerChartData.length ? 'Validated power history chart' : 'Power history unavailable'}>
                  {measurementsState.loading ? 'Loading per-inverter history…' : powerChartData.length > 1 ? (
                    <ResponsiveContainer width="100%" height="100%">
                       <LineChart data={powerChartData} margin={{ top: 10, right: 8, bottom: 10, left: 4 }}>
                        <CartesianGrid strokeDasharray="2 4" stroke="#1e293b" vertical={false} />
                         <XAxis dataKey="time" tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} tickLine={false} axisLine={false} minTickGap={16} interval="preserveStartEnd" />
                        <YAxis hide domain={['auto', 'auto']} />
                        <Tooltip contentStyle={{ backgroundColor: '#111827', borderColor: '#334155', borderRadius: '8px', fontSize: '11px' }} formatter={(value: any, name: any) => [`${Number(value).toLocaleString()} kW`, name === 'ac' ? 'AC Power' : 'DC Power']} />
                        {hasAcPower && <Line type="monotone" dataKey="ac" name="ac" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />}
                        {hasDcPower && <Line type="monotone" dataKey="dc" name="dc" stroke="#0ea5e9" strokeWidth={2} dot={false} isAnimationActive={false} />}
                      </LineChart>
                    </ResponsiveContainer>
                   ) : measurements.length ? rawPowerCount ? 'Raw source samples available.' : 'One validated sample in this range.' : 'No power samples reported.'}
                </div>
              </div>
               <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[10px] text-slate-500" aria-label="Power trend legend">
                 {hasAcPower && <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-blue-500" />AC Power · validated kW</span>}
                 {hasDcPower && <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />DC Power · validated kW</span>}
                 {!hasAcPower && !hasDcPower && <span>{powerTrendState === 'raw-only' ? 'Raw power is retained below; scaling is required before charting.' : 'Chart values appear only when source identity, semantic, unit, and scaling are validated.'}</span>}
               </div>
            </section>

            <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5" data-testid="inverter-energy-analysis">
              <div className="border-b border-[#1e293b] pb-4">
                <h3 className="text-base font-bold text-slate-100">Energy analysis</h3>
                <p className="mt-1 text-xs text-slate-500">Uses only energy values reported by {device.name}.</p>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-end">
                <div><p className="text-xs font-semibold text-orange-300">Production ({energyUnit})</p><p data-testid="inverter-energy-value" className={`mt-2 font-mono text-4xl font-bold tracking-tight ${energyMetric.value === null ? 'text-slate-500' : 'text-orange-400'}`}>{formatMetric(energyMetric, 2)}</p><p className="mt-2 text-[11px] leading-5 text-slate-500">{energyMetric.value === null ? range === 'Lifetime' ? 'Lifetime energy is not reported by this inverter.' : energyHistoryState.loading ? 'Loading source-backed inverter samples…' : rawEnergyCount ? `${rawEnergyCount} raw source sample${rawEnergyCount === 1 ? '' : 's'} found; engineering scaling is required.` : 'No per-inverter production samples are available for this range.' : `Source: ${energyMetric.source}`}</p></div>
                 <div className="flex h-28 items-center justify-center rounded-xl border border-dashed border-[#334155] bg-[#0b0f19] px-5 text-center text-xs leading-5 text-slate-500" aria-label={chartData.length ? 'Validated per-inverter energy history chart' : 'Energy history unavailable for the selected range'}>{energyHistoryState.loading ? 'Loading per-inverter history…' : chartData.length > 1 ? <ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 10, right: 10, bottom: 4, left: 4 }}><CartesianGrid strokeDasharray="2 4" stroke="#1e293b" vertical={false} /><XAxis dataKey="time" hide /><YAxis hide domain={['auto', 'auto']} /><Tooltip contentStyle={{ backgroundColor: '#111827', borderColor: '#334155', borderRadius: '8px', fontSize: '11px' }} formatter={(value) => [`${Number(value).toLocaleString()} ${energyUnit}`, 'Energy']} /><Line type="monotone" dataKey="value" stroke="#f97316" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer> : energyHistory.length ? rawEnergyCount ? 'Raw source samples available.' : 'One validated sample in this range.' : 'No per-inverter energy samples reported.'}</div>
              </div>
               <div className="mt-3 flex items-start gap-2 text-[10px] leading-4 text-slate-500"><Info size={13} className="mt-0.5 shrink-0 text-blue-400" /><span>{energyHistoryState.error ? <span role="alert" data-testid="status-inverter-energy-error" className="text-amber-300">{energyHistoryState.error}</span> : <>Samples are scoped to the configured source site {siteName} · {device.name}. Only explicitly scaling-validated samples drive the chart; raw MQTT values remain visible below. Plant totals are never used as a substitute.</>}</span></div>
                {energyHistory.length > 0 && <details className="mt-4 overflow-hidden rounded-xl border border-[#1e293b] bg-[#0f1423]"><summary className="cursor-pointer px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Source samples <span className="ml-1 font-normal normal-case tracking-normal text-slate-600">{energyHistory.length} retained</span></summary><div className="border-t border-[#1e293b]"><p className="px-3 py-2 text-[10px] text-slate-500 sm:hidden">Swipe horizontally to inspect all source fields.</p><div className="max-h-48 overflow-auto"><table className="min-w-[720px] w-full text-left text-[10px]"><thead className="sticky top-0 bg-[#0f1423]"><tr>{['Observed', 'Value', 'Parameter', 'Source', 'Address', 'Raw value', 'Scaling'].map((heading) => <th key={heading} className="px-3 py-2 font-bold uppercase tracking-wider text-slate-600">{heading}</th>)}</tr></thead><tbody className="divide-y divide-[#1e293b]/70">{energyHistory.map((sample) => <tr key={sample.id}><td className="px-3 py-2 text-slate-400">{new Date(sample.observedAt).toLocaleString()}</td><td className="px-3 py-2 font-mono text-slate-300">{sample.scalingStatus === 'validated' ? `${sample.value.toLocaleString()} ${sample.unit}` : 'Raw only'}</td><td className="px-3 py-2 font-mono text-blue-300 break-all">{sample.parameter}</td><td className="px-3 py-2 text-slate-400 break-words">{sample.sourceName}<span className="block text-[9px] text-slate-600">Configured source site</span></td><td className="px-3 py-2 font-mono text-slate-400 break-all">{sample.address}</td><td className="px-3 py-2 font-mono text-slate-300 break-all">{sample.rawValue}</td><td className={`px-3 py-2 ${sample.scalingStatus === 'validated' ? 'text-emerald-400' : 'text-amber-400'}`}>{sample.scalingStatus === 'validated' ? 'Validated' : 'Raw / Scaling Required'}</td></tr>)}</tbody></table></div></div></details>}
            </section>
          </div> : <div className="mx-auto max-w-5xl space-y-5">
            <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Device identity</p><h3 className="mt-1 text-lg font-bold text-slate-100">{device.name}</h3><p className="mt-1 text-xs text-slate-400">{device.type} · {device.site}</p></div><CustomBadge tone={statusTone}>{statusLabel}</CustomBadge></div>
              <div className="mt-5 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Asset identifier', device.id, Cpu],
                  ['Last device update', lastSeen, Activity],
                  ['Firmware', firmware ?? 'Not reported', Factory],
                   ['Source provenance', device.sourceEvidence ? `${validatedSource ? 'validated live' : device.sourceEvidence.provenance} · ${device.sourceEvidence.sourceName ?? 'raw evidence'}` : 'Device telemetry', MapPin],
                ].map((item) => {
                  const [label, value, Icon] = item as [string, string, typeof Cpu];
                  const DetailIcon = Icon;
                  return <div key={label} className="rounded-xl bg-[#0f1423] p-3"><DetailIcon size={15} className="text-slate-500" /><p className="mt-2 text-[9px] font-bold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 break-words font-mono text-[11px] font-semibold text-slate-200">{value}</p></div>;
                })}
              </div>
            </section>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard icon={Zap} label="DC bus voltage" metric={metrics.voltage} detail="Device telemetry" />
              <MetricCard icon={Activity} label="DC bus current" metric={metrics.current} detail="Device telemetry" />
              <MetricCard icon={Thermometer} label="Cabinet temperature" metric={metrics.cabinetTemp} detail="Device telemetry" />
              <MetricCard icon={Thermometer} label="Heatsink temperature" metric={metrics.heatsinkTemp} detail="Device telemetry" />
              <MetricCard icon={Gauge} label="Efficiency" metric={metrics.efficiency} detail="Device telemetry" />
              <MetricCard icon={Power} label="Reactive power" metric={metrics.reactive} detail="Device telemetry" />
              <MetricCard icon={CloudSun} label="Ambient temperature" metric={{ value: weather?.temperatureC ?? null, unit: '°C', source: weather?.locationLabel ?? 'Weather not reported', quality: weather?.temperatureC === null || weather?.temperatureC === undefined ? 'unavailable' : 'reported' }} detail="Configured site weather" />
              <MetricCard icon={CircleAlert} label="Alarm count" metric={{ value: alarms?.length ?? null, unit: '', source: alarms ? 'alarms' : 'Not reported', quality: alarms ? 'reported' : 'unavailable' }} detail="Device telemetry" />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <FaultEvidenceList title="Alarms" items={alarmEvidence} deviceModel={deviceModel} emptyMessage={alarms === null ? 'This inverter has not sent an alarm field.' : 'The device explicitly reported an empty alarm list.'} />
              <FaultEvidenceList title="Faults" items={faultEvidence} deviceModel={deviceModel} emptyMessage={faults === null ? 'This inverter has not sent a fault field.' : 'The device explicitly reported an empty fault list.'} />
            </div>

            <section className="rounded-2xl border border-[#1e293b] bg-[#111827] overflow-hidden" data-testid="inverter-archived-parameters">
              <div className="px-4 py-4 sm:px-5 border-b border-[#1e293b] bg-[#111827]">
                <h3 className="text-sm font-bold text-slate-200">Measuring point parameters</h3>
                <p className="mt-1 text-[11px] text-slate-500">Newest archived readings for this device.</p>
              </div>
              
              {newestArchivedParameters.length > 0 ? (
                <div className="overflow-x-auto scrollbar-thin max-h-[400px]">
                  <table className="w-full min-w-[800px] text-left text-xs">
                    <thead className="sticky top-0 bg-[#0f1423] shadow-[0_1px_0_0_#1e293b] z-10">
                      <tr>
                        <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Label / Parameter</th>
                        <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Value</th>
                        <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Source</th>
                        <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Address</th>
                        <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Observed</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e293b]/70 bg-[#111827]">
                      {newestArchivedParameters.map((param) => (
                        <tr key={param.parameter} className="scada-table-row hover:bg-[#1e293b]/30 transition-colors">
                          <td className="px-4 py-3 align-top">
                            <p className="font-semibold text-slate-200">{param.displayLabel || param.parameter}</p>
                            <p className="font-mono text-[10px] text-slate-500 mt-0.5">{param.parameter}</p>
                          </td>
                          <td className="px-4 py-3 align-top">
                            {param.scalingStatus === 'validated' ? (
                              <p className="font-mono text-sm font-bold text-slate-100">{param.value.toLocaleString()} <span className="text-xs text-slate-400 font-normal">{param.unit}</span></p>
                            ) : (
                              <div>
                                <p className="font-mono text-[11px] text-amber-300 break-all">{param.rawValue}</p>
                                <p className="text-[9px] uppercase tracking-wider font-bold text-amber-500/70 mt-1">Raw / Unscaled</p>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top text-slate-400">{param.sourceName}</td>
                          <td className="px-4 py-3 align-top font-mono text-[10px] text-slate-400 break-all">{param.address}</td>
                          <td className="px-4 py-3 align-top text-slate-400 whitespace-nowrap">{new Date(param.observedAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-5 text-center text-sm text-slate-500">
                  <p>{measurementsState.loading ? 'Loading archived parameters...' : 'No archived measurement parameters found in the selected period.'}</p>
                  <p className="mt-1 text-xs">Live telemetry metrics above reflect the current device state.</p>
                </div>
              )}
            </section>

            <details className="group overflow-hidden rounded-2xl border border-[#1e293b] bg-[#111827]">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-sm font-bold text-slate-200 marker:content-none sm:px-5">Raw device telemetry <span className="text-[10px] font-semibold text-slate-500 group-open:text-blue-300">{rawRows.length} fields · evidence view</span></summary>
              <div className="border-t border-[#1e293b]"><p className="px-4 py-3 text-[11px] leading-5 text-slate-500">Values below are preserved exactly as sent by this device. Raw values do not imply engineering scaling approval.</p><div className="max-h-80 overflow-auto scrollbar-thin"><p className="border-b border-[#1e293b] px-4 py-2 text-[10px] text-slate-500 sm:hidden">Swipe horizontally to inspect every field; long values wrap inside the table.</p><table className="min-w-[640px] w-full text-left text-xs"><thead className="sticky top-0 bg-[#111827]"><tr><th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Field</th><th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Value</th><th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">Type</th></tr></thead><tbody className="divide-y divide-[#1e293b]/70">{rawRows.map((row) => <tr key={row.path}><td className="max-w-[300px] break-all px-4 py-2.5 font-mono text-blue-300">{row.path}</td><td className="max-w-[360px] break-all px-4 py-2.5 font-mono text-slate-300">{row.value}</td><td className="break-words px-4 py-2.5 text-slate-500">{row.type}</td></tr>)}</tbody></table></div></div>
            </details>
          </div>}
        </div>
      </section>
    </>
  );
}