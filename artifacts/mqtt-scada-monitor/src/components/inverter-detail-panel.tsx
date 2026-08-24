import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, CircleAlert,
  CloudSun, Cpu, Factory, Gauge, Info, MapPin, Power, Thermometer, X, Zap,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type DeviceStatus = 'online' | 'stale' | 'offline';
type SourceEvidence = {
  parameter: string;
  value: number;
  address: string;
  provenance: 'live' | 'replay';
  sourceName?: string;
  observedAt?: string;
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
    return {
      value: device.sourceEvidence.value,
      unit: '',
      source: `${device.sourceEvidence.parameter} · ${device.sourceEvidence.address}`,
      quality: 'raw',
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
  if (metric.value === null) return 'Not reported';
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
      <section className="scada-power-flow relative overflow-hidden rounded-2xl border border-[#1E293B] px-3 py-5 sm:px-6" data-testid="inverter-power-flow">
      <div className="pointer-events-none absolute inset-0 opacity-[0.15] [background-image:linear-gradient(rgba(255,255,255,.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.1)_1px,transparent_1px)] [background-size:24px_24px]" />
      <div className="relative mx-auto h-[330px] max-w-5xl sm:h-[350px]">
        <svg viewBox="0 0 720 380" role="img" aria-label="Solar power flow from array through selected inverter to grid export" className="h-full w-full">
          <defs>
            <linearGradient id="inverterFlowLine" x1="0%" x2="100%">
              <stop offset="0%" stopColor="#FF5C00" />
              <stop offset="100%" stopColor="#00E5FF" />
            </linearGradient>
            <filter id="inverterFlowGlow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>
          <path d="M170 118 H304 Q328 118 328 144 V165" fill="none" className={isFlowing ? 'inverter-flow-path' : ''} stroke={isFlowing ? 'url(#inverterFlowLine)' : 'var(--scada-border)'} strokeDasharray={isFlowing ? '12 8' : undefined} strokeWidth="4" strokeLinecap="round" filter={isFlowing ? 'url(#inverterFlowGlow)' : undefined} />
          <path d="M392 165 V144 Q392 118 416 118 H554" fill="none" className={isFlowing ? 'inverter-flow-path inverter-flow-path-delayed' : ''} stroke={isFlowing ? 'url(#inverterFlowLine)' : 'var(--scada-border)'} strokeDasharray={isFlowing ? '12 8' : undefined} strokeWidth="4" strokeLinecap="round" filter={isFlowing ? 'url(#inverterFlowGlow)' : undefined} />
          <path d="M360 216 V257 H205" fill="none" stroke="var(--scada-border)" strokeWidth="3" strokeLinecap="round" />
          <g transform="translate(66 65)">
            <polygon points="0,38 88,0 144,26 55,66" fill="var(--scada-surface-raised)" stroke="var(--scada-muted)" strokeWidth="2" />
            <path d="M17 38 103 5M33 46 119 13M48 55 135 21M29 26 62 53M55 15 89 43M81 5 115 33" stroke="var(--scada-muted)" strokeWidth="1.5" opacity=".9" />
            <path d="M55 66 v35 M99 48 v53 M48 101 h58" stroke="var(--scada-muted)" strokeWidth="3" strokeLinecap="round" />
          </g>
          <g transform="translate(323 140)">
            <rect width="74" height="80" rx="11" fill="var(--scada-surface)" stroke="var(--scada-accent)" strokeWidth="2.5" filter="drop-shadow(0 0 8px rgba(0,229,255,0.3))" />
            <rect x="14" y="14" width="46" height="25" rx="4" fill="var(--scada-surface-raised)" stroke="var(--scada-border)" />
            <circle cx="37" cy="57" r="7" fill={isFlowing ? '#00F2A6' : 'var(--scada-muted)'} filter={isFlowing ? 'drop-shadow(0 0 6px rgba(0,242,166,0.5))' : undefined} />
            <path d="M33 67 h8" stroke="var(--scada-muted)" strokeWidth="2" strokeLinecap="round" />
          </g>
          <g transform="translate(555 49)">
            <path d="M48 0 0 182h96L48 0Zm0 25 25 137H23L48 25Z" fill="var(--scada-surface-raised)" stroke="var(--scada-muted)" strokeWidth="2" />
            <path d="M14 120h68M24 84h48M32 52h32M48 25v137M23 162l50-78M73 162 23 84" stroke="var(--scada-muted)" strokeWidth="2" />
            <path d="M-12 47h120M-1 47l-17 25M97 47l17 25" stroke="var(--scada-muted)" strokeWidth="3" strokeLinecap="round" />
            <rect x="17" y="186" width="62" height="12" rx="4" fill="var(--scada-border)" />
          </g>
          <g transform="translate(132 237)">
            <path d="M0 42 54 0l54 42v62H0V42Z" fill="var(--scada-surface)" stroke="var(--scada-muted)" strokeWidth="2" />
            <path d="M-8 42 54 -5l62 47" fill="none" stroke="var(--scada-muted)" strokeWidth="3" strokeLinecap="round" />
            <rect x="20" y="59" width="22" height="45" fill="var(--scada-surface-raised)" stroke="var(--scada-border)" />
            <rect x="65" y="59" width="20" height="18" fill="#FF5C00" opacity=".4" filter="drop-shadow(0 0 5px rgba(255,92,0,0.5))" />
          </g>
          <text x="112" y="160" fill="var(--scada-muted)" fontSize="13" fontWeight="700" letterSpacing="2" textAnchor="middle">SOLAR ARRAY</text>
          <text x="360" y="247" fill="var(--scada-accent)" fontSize="13" fontWeight="700" letterSpacing="2" textAnchor="middle">INVERTER</text>
          <text x="603" y="262" fill="var(--scada-muted)" fontSize="13" fontWeight="700" letterSpacing="2" textAnchor="middle">GRID</text>
          <text x="186" y="365" fill="var(--scada-muted)" fontSize="12" fontWeight="700" letterSpacing="2" textAnchor="middle">PLANT LOAD</text>
        </svg>
        <FlowLabel label="Actual power" metric={power} className="left-[3%] top-[2%] sm:left-[6%]" />
        <FlowLabel label="Actual export" metric={power} className="right-[0%] top-[63%] sm:right-[4%]" />
         <div className="absolute bottom-0 left-1/2 max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-full border border-[#1E293B] bg-[#090B13]/90 px-4 py-2 text-center text-[10px] font-bold uppercase tracking-widest text-slate-400 backdrop-blur">
          {power.quality === 'raw' ? 'Actual value received · unit pending' : power.value === null ? 'No reported power value' : isFlowing ? 'Actual power flow' : 'Flow paused until fresh inverter telemetry'}
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
    <div className="mt-5 relative z-10">
      <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Actual Value</p>
      <p className={`font-mono text-3xl font-bold tracking-tighter ${unavailable ? 'text-slate-500' : isRaw ? 'text-amber-300' : 'text-slate-100'}`}>{formatMetric(metric, 2)}</p>
      <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 border-t border-[#1E293B]/70 pt-3 text-[10px] leading-4 text-slate-500">{unavailable ? <span>Not reported</span> : isRaw ? <><span>Unit not declared</span><span>Source: {metric.source}</span><span>Status: Engineering scaling pending</span></> : <><span>{detail}</span><span>Source: {metric.source}</span><span>Status: Normal</span></>}</div>
    </div>
  </div>;
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

export default function InverterDetailPanel({ device, onClose, weather, siteName, plantTimezone, mode = 'live', now = Date.now() }: { device: Device; onClose: () => void; weather?: WeatherContext; siteName: string; plantTimezone?: string; mode?: 'demo' | 'live'; now?: number }) {
  const [tab, setTab] = useState<'Overview' | 'Device'>('Overview');
  const [range, setRange] = useState<EnergyRange>('Day');
  const [dateOffset, setDateOffset] = useState(0);
  const [energyHistory, setEnergyHistory] = useState<EnergyHistorySample[]>([]);
  const [energyHistoryState, setEnergyHistoryState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' });
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
  const firmware = typeof device.telemetry.firmware === 'string' ? device.telemetry.firmware : null;
  const statusLabel = device.sourceEvidence ? 'Source tag' : device.status === 'online' ? 'Reporting' : device.status === 'stale' ? 'Telemetry stale' : 'Not reporting';
  const statusTone = device.sourceEvidence ? 'warning' : device.status === 'online' ? 'success' : device.status === 'offline' ? 'destructive' : 'warning';
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

  return (
    <>
      <button type="button" aria-label="Close inverter details" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-[#0b0f19]/75 backdrop-blur-sm" />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${device.name} monitoring details`} tabIndex={-1} className="scada-inverter-detail-dialog fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-[#111827] shadow-2xl sm:inset-3 sm:rounded-2xl lg:inset-4 lg:left-4 lg:right-4 lg:w-auto">
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
              <div className="p-4 sm:p-5"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><Power size={15} className="text-orange-400" />Real-time power</div><p className="mt-3 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Actual Value</p><p data-testid="inverter-real-time-power" className={`mt-1 font-mono text-3xl font-bold ${metrics.power.value === null ? 'text-slate-500' : metrics.power.quality === 'raw' ? 'text-amber-300' : 'text-slate-100'}`}>{formatMetric(metrics.power, 2)}</p><div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] leading-4 text-slate-500">{metrics.power.quality === 'raw' ? <><span>Unit not declared</span><span>Source: {metrics.power.source}</span><span>Status: Engineering scaling pending</span></> : metrics.power.value === null ? <span>This inverter has not reported active power.</span> : <><span>Source: {metrics.power.source}</span><span>Status: Normal</span></>}</div></div>
              <div className="p-4 sm:p-5"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500"><Gauge size={15} className="text-orange-400" />Installed power</div><p className="mt-3 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Actual Value</p><p data-testid="inverter-installed-power" className={`mt-1 font-mono text-3xl font-bold ${metrics.capacity.value === null ? 'text-slate-500' : 'text-slate-100'}`}>{formatMetric(metrics.capacity, 2)}</p><div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] leading-4 text-slate-500">{metrics.capacity.value === null ? <><span>Capacity register not reported</span><span>Source metadata required</span></> : <><span>Source: {metrics.capacity.source}</span><span>Status: Normal</span></>}</div></div>
            </div>

            <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5" data-testid="inverter-energy-analysis">
              <div className="flex flex-col gap-4 border-b border-[#1e293b] pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div><h3 className="text-base font-bold text-slate-100">Energy analysis</h3><p className="mt-1 text-xs text-slate-500">Uses only energy values reported by {device.name}.</p></div>
                <div role="tablist" aria-label="Inverter energy period" className="scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto rounded-full bg-[#0b0f19] p-1">
                  {(['Day', 'Week', 'Month', 'Year', 'Lifetime'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={range === item} onClick={() => { setRange(item); setDateOffset(0); }} data-testid={`button-inverter-range-${item.toLowerCase()}`} className={`rounded-full px-3 py-2 text-xs font-semibold focus-ring ${range === item ? 'bg-orange-500/15 text-orange-300' : 'text-slate-500 hover:bg-[#1e293b] hover:text-slate-200'}`}>{item}</button>)}
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[#1e293b] bg-[#0f1423] px-3 py-2">
                <button type="button" disabled={range === 'Lifetime'} onClick={() => setDateOffset((offset) => offset - 1)} aria-label="Previous energy period" title={range === 'Lifetime' ? 'Lifetime history has no date navigation' : 'Previous energy period'} className="rounded-md p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600"><ChevronLeft size={18} /></button>
                <div className="min-w-0 flex-1 flex items-center justify-center gap-2 text-center text-sm font-semibold text-slate-200"><CalendarDays size={15} className="shrink-0 text-slate-500" /><span className="break-words">{energyRangeLabel(range, selectedDate)}</span></div>
                <button type="button" disabled={range === 'Lifetime' || dateOffset >= 0} onClick={() => setDateOffset((offset) => offset + 1)} aria-label="Next energy period" title={range === 'Lifetime' ? 'Lifetime history has no date navigation' : dateOffset >= 0 ? 'Future energy history is unavailable' : 'Next energy period'} className="rounded-md p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600"><ChevronRight size={18} /></button>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-end">
                <div><p className="text-xs font-semibold text-orange-300">Production</p><p className="mt-2 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Actual Value</p><p data-testid="inverter-energy-value" className={`mt-1 font-mono text-4xl font-bold tracking-tight ${energyMetric.value === null ? 'text-slate-500' : 'text-orange-400'}`}>{formatMetric(energyMetric, 2)}</p><div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px] leading-5 text-slate-500">{energyMetric.value === null ? range === 'Lifetime' ? <span>Lifetime energy is not reported by this inverter.</span> : energyHistoryState.loading ? <span>Loading source-backed inverter samples…</span> : rawEnergyCount ? <><span>{rawEnergyCount} actual source sample{rawEnergyCount === 1 ? '' : 's'}</span><span>Unit pending</span></> : <span>No per-inverter production samples are available for this range.</span> : <><span>Unit: {energyUnit}</span><span>Source: {energyMetric.source}</span><span>Status: Normal</span></>}</div></div>
                 <div className="flex h-28 items-center justify-center rounded-xl border border-dashed border-[#334155] bg-[#0b0f19] px-5 text-center text-xs leading-5 text-slate-500" aria-label={chartData.length ? 'Validated per-inverter energy history chart' : 'Energy history unavailable for the selected range'}>{energyHistoryState.loading ? 'Loading per-inverter history…' : chartData.length > 1 ? <ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 10, right: 10, bottom: 4, left: 4 }}><CartesianGrid strokeDasharray="2 4" stroke="#1e293b" vertical={false} /><XAxis dataKey="time" hide /><YAxis hide domain={['auto', 'auto']} /><Tooltip contentStyle={{ backgroundColor: '#111827', borderColor: '#334155', borderRadius: '8px', fontSize: '11px' }} formatter={(value) => [`Actual Value: ${Number(value).toLocaleString()} ${energyUnit}`, 'Energy']} /><Line type="monotone" dataKey="value" stroke="#f97316" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer> : energyHistory.length ? rawEnergyCount ? 'Actual source samples available; unit pending.' : 'One validated sample in this range.' : 'No per-inverter energy samples reported.'}</div>
              </div>
               <div className="mt-3 flex items-start gap-2 text-[10px] leading-4 text-slate-500"><Info size={13} className="mt-0.5 shrink-0 text-blue-400" /><span>{energyHistoryState.error ? <span role="alert" data-testid="status-inverter-energy-error" className="text-amber-300">{energyHistoryState.error}</span> : <>Samples are scoped to the configured source site {siteName} · {device.name}. Only scaling-validated samples drive the chart; actual values from MQTT remain available in the source samples below. Plant totals are never used as a substitute.</>}</span></div>
                {energyHistory.length > 0 && <details className="mt-4 overflow-hidden rounded-xl border border-[#1e293b] bg-[#0f1423]"><summary className="cursor-pointer px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Source samples <span className="ml-1 font-normal normal-case tracking-normal text-slate-600">{energyHistory.length} retained</span></summary><div className="border-t border-[#1e293b]"><p className="px-3 py-2 text-[10px] text-slate-500 sm:hidden">Swipe horizontally to inspect all source fields.</p><div className="max-h-48 overflow-auto"><table className="min-w-[720px] w-full text-left text-[10px]"><thead className="sticky top-0 bg-[#0f1423]"><tr>{['Last Updated', 'Actual Value', 'Parameter', 'Source', 'Modbus Register', 'Original Value', 'Status'].map((heading) => <th key={heading} className="px-3 py-2 font-bold uppercase tracking-wider text-slate-600">{heading}</th>)}</tr></thead><tbody className="divide-y divide-[#1e293b]/70">{energyHistory.map((sample) => <tr key={sample.id}><td className="px-3 py-2 text-slate-400">{new Date(sample.observedAt).toLocaleString()}</td><td className="px-3 py-2 font-mono text-slate-300">{sample.scalingStatus === 'validated' ? `${sample.value.toLocaleString()} ${sample.unit}` : `${sample.value.toLocaleString()} · unit pending`}</td><td className="px-3 py-2 font-mono text-blue-300 break-all">{sample.parameter}</td><td className="px-3 py-2 text-slate-400 break-words">{sample.sourceName}<span className="block text-[9px] text-slate-600">Configured source site</span></td><td className="px-3 py-2 font-mono text-slate-400 break-all">{sample.address}</td><td className="px-3 py-2 font-mono text-slate-300 break-all">{sample.rawValue}</td><td className={`px-3 py-2 ${sample.scalingStatus === 'validated' ? 'text-emerald-400' : 'text-amber-400'}`}>{sample.scalingStatus === 'validated' ? 'Normal' : 'Unit pending'}</td></tr>)}</tbody></table></div></div></details>}
            </section>
          </div> : <div className="mx-auto max-w-5xl space-y-5">
            <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Device identity</p><h3 className="mt-1 text-lg font-bold text-slate-100">{device.name}</h3><p className="mt-1 text-xs text-slate-400">{device.type} · {device.site}</p></div><CustomBadge tone={statusTone}>{statusLabel}</CustomBadge></div>
              <div className="mt-5 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Asset identifier', device.id, Cpu],
                  ['Last device update', lastSeen, Activity],
                  ['Firmware', firmware ?? 'Not reported', Factory],
                  ['Source provenance', device.sourceEvidence ? `${device.sourceEvidence.provenance} · ${device.sourceEvidence.sourceName ?? 'raw evidence'}` : 'Device telemetry', MapPin],
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
              <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Alarms</p><h3 className="mt-1 text-sm font-bold text-slate-100">{alarms === null ? 'Alarm state not reported' : alarms.length ? `${alarms.length} reported alarm${alarms.length === 1 ? '' : 's'}` : 'No active alarms reported'}</h3></div><CircleAlert size={20} className={alarms?.length ? 'text-rose-400' : alarms === null ? 'text-slate-500' : 'text-emerald-400'} /></div>{alarms?.length ? <ul className="mt-4 space-y-2">{alarms.map((alarm, index) => <li key={index} className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{formatRawValue(alarm)}</li>)}</ul> : <p className="mt-4 text-xs leading-5 text-slate-500">{alarms === null ? 'This inverter has not sent an alarm field.' : 'The device explicitly reported an empty alarm list.'}</p>}</section>
              <section className="rounded-2xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Faults</p><h3 className="mt-1 text-sm font-bold text-slate-100">{faults === null ? 'Fault state not reported' : faults.length ? `${faults.length} reported fault${faults.length === 1 ? '' : 's'}` : 'No active faults reported'}</h3></div><CircleAlert size={20} className={faults?.length ? 'text-rose-400' : faults === null ? 'text-slate-500' : 'text-emerald-400'} /></div>{faults?.length ? <ul className="mt-4 space-y-2">{faults.map((fault, index) => <li key={index} className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{formatRawValue(fault)}</li>)}</ul> : <p className="mt-4 text-xs leading-5 text-slate-500">{faults === null ? 'This inverter has not sent a fault field.' : 'The device explicitly reported an empty fault list.'}</p>}</section>
            </div>

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