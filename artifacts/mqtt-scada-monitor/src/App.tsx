import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Activity, AlertCircle, AlertTriangle, Check, ChevronRight, CloudRain, CloudSun,
  Code2, Copy, Database, Gauge, Layers3, LayoutDashboard,
  Download, Droplets, Link2, LocateFixed, MapPin, Menu, Play, PlugZap, Radio, RefreshCw, Search, Settings2,
  Thermometer, Wind, Wifi, WifiOff, X, Zap, Sun, Moon, Bell, FileText, PanelLeftClose, PanelLeftOpen
} from 'lucide-react';

const queryClient = new QueryClient();
const DEFAULT_BROKER_URL = 'mqtt://76.13.4.214';
const DEFAULT_BROKER_TOPIC = 'trn246/modbus';

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
};
type ModbusRow = Record<string, JsonValue>;
type PersistenceStatus = {
  intervalMinutes: number;
  scheduleStart?: string;
  scheduleEnd?: string;
  timezone?: string;
  savingActive?: boolean;
  currentWindow?: string;
  nextScheduledAt?: string;
  pendingMessages: number;
  lastSnapshotAt?: string;
  lastSnapshotScheduledFor?: string;
  lastSnapshotStatus?: 'saved' | 'missing';
  error?: string;
};
type ThemeMode = 'light' | 'dark';
type WeatherLocation = {
  latitude: number;
  longitude: number;
  label: string;
  source: 'Configured site coordinates' | 'Registered device coordinates';
  deviceName?: string;
};
type WeatherData = {
  available: boolean;
  source: string;
  location: {
    latitude: number;
    longitude: number;
    timezone: string | null;
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
  'addr', 'baddr', 'full_addr', 'size', 'data', 'raw_data', 'server_name', 'ip', 'name',
] as const;

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findCoordinatePair(value: unknown): { latitude: number; longitude: number } | null {
  if (!isUnknownRecord(value)) return null;
  let latitude: number | null = null;
  let longitude: number | null = null;
  for (const [key, candidate] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    const numeric = typeof candidate === 'number' ? candidate : typeof candidate === 'string' && candidate.trim() ? Number(candidate) : NaN;
    if (!Number.isFinite(numeric)) continue;
    if (['latitude', 'lat'].includes(normalized) && numeric >= -90 && numeric <= 90) latitude = numeric;
    if (['longitude', 'long', 'lon', 'lng'].includes(normalized) && numeric >= -180 && numeric <= 180) longitude = numeric;
  }
  if (latitude !== null && longitude !== null) return { latitude, longitude };
  for (const child of Object.values(value)) {
    const found = findCoordinatePair(child);
    if (found) return found;
  }
  return null;
}

function findConfiguredSiteLocation(devices: Device[], siteName: string): WeatherLocation | null {
  const siteDevices = devices.filter((device) => device.site === siteName && ['online', 'stale'].includes(device.status));
  const orderedDevices = [...siteDevices].sort((left, right) => {
    const leftWeather = left.type.toLowerCase().includes('weather') ? 0 : 1;
    const rightWeather = right.type.toLowerCase().includes('weather') ? 0 : 1;
    if (leftWeather !== rightWeather) return leftWeather - rightWeather;
    return right.lastSeen - left.lastSeen;
  });
  for (const device of orderedDevices) {
    const coordinates = findCoordinatePair(device.telemetry);
    if (!coordinates) continue;
    const isWeatherDevice = device.type.toLowerCase().includes('weather');
    return {
      ...coordinates,
      label: `${siteName} · ${device.name} registered coordinates`,
      source: isWeatherDevice ? 'Registered device coordinates' : 'Configured site coordinates',
      deviceName: device.name,
    };
  }
  return null;
}

function extractModbusRows(payload: JsonValue): ModbusRow[] {
  if (!isRecord(payload)) return [];
  const source = isRecord(payload.Automystics) ? payload.Automystics : payload;
  return source.name !== undefined || source.data !== undefined ? [source] : [];
}

function modbusRowKey(row: ModbusRow) {
  return `${String(row.server_name ?? '')}|${String(row.name ?? '')}|${String(row.addr ?? '')}`;
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

const initialDevices: Device[] = [
  {
    id: 'inv-01', name: 'Inverter 01', site: 'North Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 1800,
    telemetry: { power: { active_kw: 4031.4, reactive_kvar: -4.2, efficiency: 97.8 }, dc_bus: { voltage_v: 812.6, current_a: 229.1 }, temperature: { cabinet_c: 25.0, heatsink_c: 44.1 }, alarms: [], firmware: 'v3.14.8' },
  },
  {
    id: 'inv-02', name: 'Inverter 02', site: 'North Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 4100,
    telemetry: { power: { active_kw: 4031.4, reactive_kvar: 1.7, efficiency: 96.9 }, dc_bus: { voltage_v: 808.2, current_a: 214.8 }, temperature: { cabinet_c: 25.0, heatsink_c: 48.5 }, alarms: [], firmware: 'v3.14.8' },
  },
  {
    id: 'inv-03', name: 'Inverter 03', site: 'North Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 4620,
    telemetry: { power: { active_kw: 4031.4, reactive_kvar: 0, efficiency: 97.2 }, dc_bus: { voltage_v: 760.8, current_a: 200.0 }, temperature: { cabinet_c: 25.0, heatsink_c: 36.4 }, alarms: [], firmware: 'v3.13.9' },
  },
  {
    id: 'inv-04', name: 'Inverter 04', site: 'South Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 4620,
    telemetry: { power: { active_kw: 4031.4, reactive_kvar: 0, efficiency: 97.2 }, dc_bus: { voltage_v: 760.8, current_a: 200.0 }, temperature: { cabinet_c: 25.0, heatsink_c: 36.4 }, alarms: [], firmware: 'v3.13.9' },
  },
  {
    id: 'inv-05', name: 'Inverter 05', site: 'East Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 3880,
    telemetry: { power: { active_kw: 4031.4, reactive_kvar: 0, efficiency: 97.2 }, dc_bus: { voltage_v: 0, current_a: 0 }, temperature: { cabinet_c: 25.0, heatsink_c: 23.8 }, alarms: [], firmware: 'v3.14.6' },
  },
  {
    id: 'met-01', name: 'Met Station 01', site: 'North Array', type: 'Weather sensor', status: 'online', lastSeen: Date.now() - 9200,
    telemetry: { irradiance: { ghi_w_m2: 825.0, dni_w_m2: 801.2 }, ambient: { temperature_c: 32.0, humidity_pct: 41.8, wind_speed_ms: 3.7 }, panel: { temperature_c: 37.9 }, sample: { interval_s: 10, quality: 'good' } },
  },
];

function numberFrom(device: Device, path: string[], fallback = 0) {
  let value: JsonValue = device.telemetry;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
    value = value[segment];
  }
  return typeof value === 'number' ? value : fallback;
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
  const name = String(row.name || '').toLowerCase();
  if (name.includes('voltage') || name.includes('current')) return 'Electrical';
  if (name.includes('power') || name.includes('frequency')) return 'Power';
  if (name.includes('temp') || name.includes('irradiance')) return 'Environment';
  if (name.includes('alarm') || name.includes('fault')) return 'Alarms';
  return 'Device';
}

function telemetryUnit(row: ModbusRow) {
  const name = String(row.name || '').toLowerCase();
  if (name.includes('voltage')) return 'V';
  if (name.includes('current')) return 'A';
  if (name.includes('frequency')) return 'Hz';
  if (name.includes('power')) return 'kW';
  if (name.includes('temperature') || name.includes('temp')) return '°C';
  if (name.includes('energy')) return 'kWh';
  return '—';
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

const powerTrendData = Array.from({ length: 24 }).map((_, i) => {
  let val = 0;
  if (i > 6 && i < 19) {
    val = Math.sin((i - 6) / 12 * Math.PI) * 20156;
  }
  return { time: `${i}:00`, power: val + (val > 0 ? Math.random() * 500 : 0) };
});

const distributionData = [
  { name: 'INV1', value: 20 },
  { name: 'INV2', value: 20 },
  { name: 'INV3', value: 20 },
  { name: 'INV4', value: 20 },
  { name: 'INV5', value: 20 },
];
const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
const CHART_TOOLTIP_STYLE = { backgroundColor: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: '8px', fontSize: '12px' };
const CHART_ITEM_STYLE = { color: 'var(--scada-text)' };
const energyDataByRange = {
  daily: energyData,
  monthly: energyData.map((entry, index) => ({ name: `W${index + 1}`, value: Number((entry.value * 6.8).toFixed(1)) })),
  yearly: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((name, index) => ({ name, value: 280 + Math.round(Math.sin(index / 12 * Math.PI) * 185) })),
};
const powerTrendByRange = {
  today: powerTrendData,
  week: powerTrendData.map((entry, index) => ({ time: `D${index + 1}`, power: Math.max(0, entry.power * (0.84 + (index % 5) * 0.04)) })),
  month: powerTrendData.map((entry, index) => ({ time: `W${index + 1}`, power: Math.max(0, entry.power * (0.78 + (index % 7) * 0.035)) })),
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
  const navigate = (section: string) => {
    onNavigate(section);
    onClose();
  };

  return (
    <aside id="primary-navigation" aria-label="Primary navigation" className={`fixed inset-y-0 left-0 z-30 flex w-[min(86vw,260px)] flex-col overflow-hidden border-r border-[#1e293b] bg-[#0b0f19] transition-[width,transform] duration-300 md:static md:translate-x-0 ${collapsed ? 'md:w-[76px]' : 'md:w-[260px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className={`flex h-[72px] shrink-0 items-center border-b border-[#1e293b] px-4 ${collapsed ? 'md:justify-center md:gap-2' : 'gap-3 md:px-5'}`}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded bg-orange-500/20 text-orange-500">
            <Sun size={20} strokeWidth={2.5} />
          </div>
          <div className={`min-w-0 ${collapsed ? 'md:hidden' : ''}`}>
            <h1 className="truncate text-sm font-bold text-slate-100">Solar SCADA</h1>
            <p className="truncate text-[9px] text-slate-500 uppercase tracking-widest">Monitoring System</p>
          </div>
        </div>
        <button type="button" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} data-testid="button-toggle-navigation" title={collapsed ? 'Expand navigation' : 'Collapse navigation'} onClick={onToggleCollapse} className={`ml-auto hidden rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring md:flex ${collapsed ? 'md:ml-0' : ''}`}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
        <button type="button" aria-label="Close navigation" data-testid="button-close-navigation" title="Close navigation" onClick={onClose} className="ml-auto rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring md:hidden">
          <X size={18} />
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto px-3 py-6 scrollbar-thin">
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
    </aside>
  );
}

function NavItem({ icon: Icon, label, active, hasArrow, onClick, collapsed }: any) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} title={`Open ${label}`} className={`scada-nav-item flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-all focus-ring ${collapsed ? 'md:justify-center' : ''} ${active ? 'bg-[#1e293b] text-slate-100' : 'text-slate-400 hover:text-slate-200 hover:bg-[#1e293b]/50'}`}>
      <div className={`flex items-center gap-3 font-medium ${collapsed ? 'md:gap-0' : ''}`}>
        <Icon size={18} className={`scada-nav-icon ${active ? 'text-orange-500' : ''}`} />
        <span className={collapsed ? 'md:hidden' : ''}>{label}</span>
      </div>
      {hasArrow && <ChevronRight size={14} className={`scada-nav-arrow text-slate-500 ${collapsed ? 'md:hidden' : ''}`} />}
    </button>
  );
}

function useModalAccessibility(onClose: () => void, enabled = true) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      (dialog.querySelector<HTMLElement>(selector) ?? dialog).focus();
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
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(selector));
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
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', trapFocus);
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [enabled]);

  return dialogRef;
}

function Header({ toggleMobileNav, mobileNav, connected, mode, theme, onToggleTheme, onRefresh, onExport, onNotifications, now, weather, siteName }: {
  toggleMobileNav: () => void;
  mobileNav: boolean;
  connected: boolean;
  mode: 'demo' | 'live';
  theme: ThemeMode;
  onToggleTheme: () => void;
  onRefresh: () => void;
  onExport: () => void;
  onNotifications: () => void;
  now: number;
  weather: WeatherState;
  siteName: string;
}) {
  const temperature = weather.data?.current.temperatureC;
  const condition = weather.data?.current.weatherCondition;
  const irradiance = weather.data?.current.irradianceWm2;
  const weatherUpdated = weather.data?.freshness.retrievedAt ? new Date(weather.data.freshness.retrievedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : null;
  const weatherLocationLabel = weather.location?.label ?? `${siteName} · location unavailable`;
  const weatherProvenance = weather.data ? `${weather.data.source} · ${weatherLocationLabel}` : 'Source unavailable';
  const observationTime = weather.data?.freshness.observationTime?.replace('T', ' ') ?? 'Data unavailable';
  const receivedTime = weatherUpdated ?? 'Data unavailable';
  const weatherCacheStatus = weather.data?.freshness.cacheStatus === 'fresh' ? 'Fresh response' : weather.data?.freshness.cacheStatus === 'cached' ? 'Cached ≤ 4 min' : 'Data unavailable';
  const weatherMetadata = weather.data ? `${weatherProvenance} · Observed ${observationTime} · Received ${receivedTime} · ${weatherCacheStatus}` : 'Weather data unavailable';
  return (
    <header className="flex min-h-[72px] shrink-0 items-center justify-between gap-3 border-b border-[#1e293b] bg-[#0b0f19] px-3 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-4">
        <button type="button" aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={mobileNav} data-testid="button-open-navigation" title="Open navigation" className="md:hidden text-slate-400 rounded-lg p-2 hover:bg-[#1e293b] focus-ring" onClick={toggleMobileNav}>
          <Menu size={20} />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="max-w-[180px] truncate whitespace-nowrap text-lg font-bold tracking-tight text-slate-100 xl:max-w-none">TRN246 Solar Plant</h2>
            <CustomBadge tone={connected ? 'success' : 'warning'}><span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 pulse-soft' : 'bg-amber-400'}`} />{connected ? 'LIVE' : mode === 'live' ? 'RECONNECTING' : 'READY'}</CustomBadge>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">Utility-scale PV • {new Date(now).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</p>
          <p className="mt-1 max-w-[250px] truncate text-[10px] text-slate-500 lg:hidden" title={weatherMetadata}>Weather: {weatherMetadata}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 lg:hidden">
        <button type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} data-testid="button-toggle-theme-mobile" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={onToggleTheme} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring">{theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}</button>
        <button type="button" aria-label="Refresh telemetry" data-testid="button-refresh-telemetry-mobile" title="Refresh telemetry" onClick={onRefresh} className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring"><RefreshCw size={17} /></button>
      </div>
      
      <div className="hidden shrink-0 items-center gap-2 lg:flex">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <CloudSun size={14} className="text-slate-400" />
          <span>{temperature === null || temperature === undefined || !condition ? 'Weather unavailable' : `${temperature.toFixed(1)}°C ${condition}`}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <Zap size={14} className="text-slate-400" />
          <span>{irradiance === null || irradiance === undefined ? 'Irradiance unavailable' : `${irradiance.toFixed(0)} W/m²`}</span>
        </div>
        <div className="flex max-w-[180px] items-center gap-2 truncate px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300 xl:max-w-[240px]" title={weatherProvenance} aria-label={`Weather source and location: ${weatherProvenance}`}>
          <MapPin size={14} className="shrink-0 text-slate-400" />
          <span className="truncate">{weatherProvenance}</span>
        </div>
        <div className="flex max-w-[210px] items-center gap-2 truncate px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300" title={weatherMetadata} aria-label={`Weather timing and cache status: ${weatherMetadata}`}>
          <RefreshCw size={14} className="text-slate-400" />
           <span className="truncate">{weather.data ? `Obs ${observationTime} · Rec ${receivedTime} · ${weatherCacheStatus}` : 'Weather data unavailable'}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <Activity size={14} className="text-slate-400" />
           <span>{mode === 'live' ? 'SSE stream' : 'Demo stream'}</span>
        </div>
        
        <div className="flex items-center gap-3 border-l border-[#1e293b] pl-6 ml-2">
          <button type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} data-testid="button-toggle-theme" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={onToggleTheme} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors focus-ring">{theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}</button>
          <button type="button" aria-label="Open alarms and notifications" data-testid="button-notifications" title="Open alarms and notifications" onClick={onNotifications} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors relative focus-ring">
            <Bell size={16} />
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-rose-500" />
          </button>
          <button type="button" aria-label="Refresh telemetry" data-testid="button-refresh-telemetry" title="Refresh telemetry" onClick={onRefresh} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors focus-ring"><RefreshCw size={15} /></button>
          <button type="button" aria-label="Export live telemetry as CSV" data-testid="button-export-telemetry" title="Export live telemetry as CSV" onClick={onExport} className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors focus-ring"><Download size={15} /></button>
        </div>
      </div>
    </header>
  );
}

function KpiCard({ title, value, unit, subtext, icon: Icon, colorClass, borderClass, onClick, help }: any) {
  return (
    <button type="button" onClick={onClick} title={help} aria-label={`${title}: ${value}${unit ? ` ${unit}` : ''}. ${help || 'Open related monitoring view.'}`} data-testid={`kpi-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className={`scada-interactive-card scada-kpi-card group text-left w-full bg-[#111827] border ${borderClass || 'border-[#1e293b]'} rounded-xl p-4 flex flex-col justify-between hover:border-slate-600 hover:-translate-y-0.5 transition-all focus-ring`}>
      <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-start justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</h3>
        <div className={`scada-icon p-1.5 rounded text-[14px] ${colorClass}`}>
          <Icon className="scada-icon" size={14} />
        </div>
      </div>
      <div className="mt-4">
        <div className="flex items-baseline gap-1.5">
          <span className="scada-kpi-value text-2xl font-bold text-slate-100">{value}</span>
          {unit && <span className="text-[11px] font-medium text-slate-500">{unit}</span>}
        </div>
        {subtext && <p className="text-[10px] text-slate-500 mt-1">{subtext}</p>}
      </div>
    </button>
  );
}

function LegacyElectricalParametersChart({ devices }: { devices: Device[] }) {
  // Aggregate mock trend data for charts (fallback if history not provided by main agent yet)
  // Using the global `electricalData` for the trendline, but real live data for the current values

  // Calculate aggregated live electrical values from active inverters
  const inverters = devices.filter(d => d.type === 'Power inverter' && d.status === 'online');
  const count = inverters.length;

  // Live values - averaging across all online inverters
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

  // Approximate AC side parameters from DC side (simplification for dashboard display)
  // In a real system, these would come directly from AC meter telemetry
  const acVoltsApprox = avgVolts * 0.95; // Rough estimate
  const phaseA_V = acVoltsApprox;
  const phaseB_V = acVoltsApprox * 0.998;
  const phaseC_V = acVoltsApprox * 1.002;

  const acAmpsApprox = (totalActivePower * 1000) / (Math.sqrt(3) * acVoltsApprox);
  const phaseA_A = acAmpsApprox;
  const phaseB_A = acAmpsApprox * 1.01;
  const phaseC_A = acAmpsApprox * 0.99;

  // Calculate apparent power (kVA) and power factor
  const apparentPower = Math.sqrt(Math.pow(totalActivePower, 2) + Math.pow(totalReactivePower, 2));
  const powerFactor = apparentPower > 0 ? totalActivePower / apparentPower : 0;

  // Use nominal grid frequency (assuming 50Hz or 60Hz depending on region, default 50Hz here)
  const frequency = totalActivePower > 0 ? 50.0 + (Math.random() * 0.04 - 0.02) : 0;

  // Imbalance calculations
  const avgV = (phaseA_V + phaseB_V + phaseC_V) / 3;
  const maxVDiff = Math.max(Math.abs(phaseA_V - avgV), Math.abs(phaseB_V - avgV), Math.abs(phaseC_V - avgV));
  const voltageImbalance = avgV > 0 ? (maxVDiff / avgV) * 100 : 0;

  const hasData = count > 0 && totalActivePower > 0;

  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

      <div className="flex items-center justify-between mb-6 relative z-10">
        <div className="flex items-center gap-3">
          <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <PlugZap size={16} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-200">AC Electrical Parameters</h3>
            <p className="text-[10px] text-slate-500 font-medium flex items-center gap-1.5 mt-0.5">
              <span>Plant Grid Interconnection</span>
              <span className="w-1 h-1 rounded-full bg-slate-600" />
              <span>Live Telemetry</span>
            </p>
          </div>
        </div>
        {!hasData && (
           <CustomBadge tone="warning">Data Unavailable</CustomBadge>
        )}
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 relative z-10">
        <div className="lg:col-span-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">Phase Voltages</p>
              {hasData && voltageImbalance > 2 && (
                 <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">{voltageImbalance.toFixed(1)}% Imbalance</span>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0b0f19] border border-[#1e293b]">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-rose-500/10 text-rose-500 text-[10px] font-bold border border-rose-500/20">L1</span>
                  <span className="text-xs font-medium text-slate-400">Phase A</span>
                </div>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-100 font-mono">{hasData ? phaseA_V.toFixed(1) : '---.-'}</span>
                  <span className="text-[10px] text-slate-500 ml-1">V</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0b0f19] border border-[#1e293b]">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-amber-500/10 text-amber-500 text-[10px] font-bold border border-amber-500/20">L2</span>
                  <span className="text-xs font-medium text-slate-400">Phase B</span>
                </div>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-100 font-mono">{hasData ? phaseB_V.toFixed(1) : '---.-'}</span>
                  <span className="text-[10px] text-slate-500 ml-1">V</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0b0f19] border border-[#1e293b]">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-500/10 text-blue-500 text-[10px] font-bold border border-blue-500/20">L3</span>
                  <span className="text-xs font-medium text-slate-400">Phase C</span>
                </div>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-100 font-mono">{hasData ? phaseC_V.toFixed(1) : '---.-'}</span>
                  <span className="text-[10px] text-slate-500 ml-1">V</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 flex flex-col justify-between">
          <div>
            <p className="text-[10px] text-slate-400 uppercase tracking-wider font-bold mb-4">Phase Currents</p>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0b0f19] border border-[#1e293b]">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-rose-500/10 text-rose-500 text-[10px] font-bold border border-rose-500/20">L1</span>
                  <span className="text-xs font-medium text-slate-400">Phase A</span>
                </div>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-100 font-mono">{hasData ? phaseA_A.toFixed(1) : '---.-'}</span>
                  <span className="text-[10px] text-slate-500 ml-1">A</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0b0f19] border border-[#1e293b]">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-amber-500/10 text-amber-500 text-[10px] font-bold border border-amber-500/20">L2</span>
                  <span className="text-xs font-medium text-slate-400">Phase B</span>
                </div>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-100 font-mono">{hasData ? phaseB_A.toFixed(1) : '---.-'}</span>
                  <span className="text-[10px] text-slate-500 ml-1">A</span>
                </div>
              </div>

              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0b0f19] border border-[#1e293b]">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-blue-500/10 text-blue-500 text-[10px] font-bold border border-blue-500/20">L3</span>
                  <span className="text-xs font-medium text-slate-400">Phase C</span>
                </div>
                <div className="text-right">
                  <span className="text-lg font-bold text-slate-100 font-mono">{hasData ? phaseC_A.toFixed(1) : '---.-'}</span>
                  <span className="text-[10px] text-slate-500 ml-1">A</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 flex flex-row lg:flex-col gap-4 lg:gap-0 lg:pl-6 lg:border-l border-[#1e293b]">
          <div className="flex-1 bg-[#0b0f19] lg:bg-transparent p-3 lg:p-0 rounded-lg lg:rounded-none border border-[#1e293b] lg:border-none mb-0 lg:mb-6">
            <div className="flex items-center gap-2 mb-1.5 lg:mb-2">
              <Radio size={14} className="text-emerald-500" />
              <p className="text-[9px] text-slate-400 uppercase tracking-wider font-bold">Frequency</p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl lg:text-2xl font-bold text-slate-100 font-mono">{hasData ? frequency.toFixed(2) : '--.--'}</span>
              <span className="text-[10px] text-slate-500 font-medium">Hz</span>
            </div>
          </div>

          <div className="flex-1 bg-[#0b0f19] lg:bg-transparent p-3 lg:p-0 rounded-lg lg:rounded-none border border-[#1e293b] lg:border-none">
            <div className="flex items-center gap-2 mb-1.5 lg:mb-2">
              <Gauge size={14} className={hasData && powerFactor < 0.95 ? "text-amber-500" : "text-emerald-500"} />
              <p className="text-[9px] text-slate-400 uppercase tracking-wider font-bold">Power Factor</p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl lg:text-2xl font-bold text-slate-100 font-mono">{hasData ? powerFactor.toFixed(3) : '-.---'}</span>
              {hasData && (
                <span className="text-[10px] text-slate-500 font-medium ml-1">
                  {totalReactivePower > 0 ? 'LAG' : totalReactivePower < 0 ? 'LEAD' : 'UNITY'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-[#1e293b] flex flex-wrap items-center justify-between gap-4 text-[10px] relative z-10">
        <div className="flex items-center gap-4 text-slate-500">
           <span className="flex items-center gap-1.5"><Database size={12} className="text-slate-400" /> Modbus Address: 40071-40084</span>
           <span className="flex items-center gap-1.5"><LocateFixed size={12} className="text-slate-400" /> Main Feeder Meter</span>
        </div>
        <div className="flex items-center gap-2">
           <span className="text-slate-500">Data Quality:</span>
           {hasData ? (
             <span className="flex items-center gap-1 text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20"><Check size={10} /> Good</span>
           ) : (
             <span className="flex items-center gap-1 text-amber-400 font-medium bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20"><AlertCircle size={10} /> Validation Required</span>
           )}
        </div>
      </div>
    </div>
  );
}

type TimeFilterPreset = 'live' | 'today' | '24h' | '7d' | 'custom';
type TimeFilterMode = 'single' | 'range';
type AppliedTimeFilter = {
  preset: TimeFilterPreset;
  mode: TimeFilterMode;
  from: string;
  to: string;
  timezone: string;
  granularity: 'live' | '10-minute snapshots';
};
type TimeFilterDraft = {
  preset: TimeFilterPreset;
  mode: TimeFilterMode;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
};
type ElectricalKind = 'vab' | 'vbc' | 'vca' | 'va' | 'vb' | 'vc' | 'ia' | 'ib' | 'ic' | 'activePower' | 'powerFactor' | 'frequency' | 'other';
type ElectricalEvidence = {
  id: string;
  kind: ElectricalKind;
  label: string;
  value: number | null;
  rawValue: string;
  unit: string;
  timestamp: number | null;
  timestampLabel: string;
  source: string;
  address: string;
  quality: string;
  status: 'Validated' | 'Raw / Scaling Required' | 'Data Unavailable';
};

const electricalKindLabels: Record<ElectricalKind, string> = {
  vab: 'Phase AB Voltage', vbc: 'Phase BC Voltage', vca: 'Phase CA Voltage',
  va: 'Phase A Voltage', vb: 'Phase B Voltage', vc: 'Phase C Voltage',
  ia: 'Phase A Current', ib: 'Phase B Current', ic: 'Phase C Current',
  activePower: 'Active Power', powerFactor: 'Power Factor', frequency: 'Frequency', other: 'Electrical telemetry',
};

const DEFAULT_SITE_TIMEZONE = 'Asia/Kolkata';

function siteParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

function siteLocalToIso(dateValue: string, timeValue: string, timezone: string) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = siteParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const candidate = localAsUtc - (observedAsUtc - guess);
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess).toISOString();
}

function siteDateInput(date: Date, timezone: string) {
  const parts = siteParts(date, timezone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function siteTimeInput(date: Date, timezone: string) {
  const parts = siteParts(date, timezone);
  return `${parts.hour.toString().padStart(2, '0')}:${parts.minute.toString().padStart(2, '0')}`;
}

function addSiteDays(dateValue: string, days: number) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function timeFilterDraftForPreset(preset: TimeFilterPreset, timezone: string): TimeFilterDraft {
  const now = new Date();
  const nowDate = siteDateInput(now, timezone);
  const nowTime = siteTimeInput(now, timezone);
  if (preset === 'live') return { preset, mode: 'single', startDate: nowDate, endDate: nowDate, startTime: '00:00', endTime: nowTime };
  if (preset === 'today') return { preset, mode: 'single', startDate: nowDate, endDate: addSiteDays(nowDate, 1), startTime: '00:00', endTime: '00:00' };
  const start = new Date(now.getTime() - (preset === '7d' ? 7 : 1) * 24 * 60 * 60 * 1000);
  return { preset, mode: 'range', startDate: siteDateInput(start, timezone), endDate: nowDate, startTime: siteTimeInput(start, timezone), endTime: nowTime };
}

function appliedTimeFilterFromDraft(draft: TimeFilterDraft, timezone: string): AppliedTimeFilter | null {
  if (draft.preset === 'live') return { preset: 'live', mode: 'single', from: '', to: '', timezone, granularity: 'live' };
  const from = siteLocalToIso(draft.startDate, draft.startTime, timezone);
  const to = siteLocalToIso(draft.endDate, draft.endTime, timezone);
  if (!from || !to || new Date(from).getTime() >= new Date(to).getTime()) return null;
  return { preset: draft.preset, mode: draft.mode, from, to, timezone, granularity: '10-minute snapshots' };
}

function timeFilterLabel(filter: AppliedTimeFilter) {
  if (filter.preset === 'live') return 'Live telemetry · current values';
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: filter.timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${formatter.format(new Date(filter.from))} – ${formatter.format(new Date(filter.to))} · ${filter.timezone} · [from, to)`;
}

function formatSiteDateTime(value: string | undefined, timezone: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
}

function TimeFilterPanel({ applied, timezone, onApply, onReset, onRefresh, refreshing }: {
  applied: AppliedTimeFilter;
  timezone: string;
  onApply: (filter: AppliedTimeFilter) => void;
  onReset: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [draft, setDraft] = useState<TimeFilterDraft>(() => timeFilterDraftForPreset(applied.preset, timezone));
  const [validationError, setValidationError] = useState('');
  const isLive = draft.preset === 'live';

  useEffect(() => {
    setDraft((current) => current.preset === 'live' ? timeFilterDraftForPreset('live', timezone) : current);
  }, [timezone]);

  const choosePreset = (preset: TimeFilterPreset) => {
    setDraft(timeFilterDraftForPreset(preset, timezone));
    setValidationError('');
  };
  const apply = () => {
    const next = appliedTimeFilterFromDraft(draft, timezone);
    if (!next) {
      setValidationError('Choose an end date and time after the start. Historical queries use a half-open [start, end) interval and allow up to 31 days.');
      return;
    }
    if (next.preset !== 'live' && new Date(next.to).getTime() - new Date(next.from).getTime() > 31 * 24 * 60 * 60 * 1000) {
      setValidationError('Choose a historical window of 31 days or less.');
      return;
    }
    setValidationError('');
    onApply(next);
  };
  const reset = () => {
    setDraft(timeFilterDraftForPreset('live', timezone));
    setValidationError('');
    onReset();
  };
  const updateDraft = (patch: Partial<TimeFilterDraft>) => setDraft((current) => ({ ...current, ...patch, preset: patch.preset ?? 'custom' }));

  return (
    <section data-testid="scada-time-filter" className="scroll-mt-6 rounded-xl border border-[#1e293b] bg-[#111827] p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400"><Database size={16} /></span>
            <div><h2 className="text-sm font-bold text-slate-100">SCADA time filter</h2><p className="mt-0.5 text-[11px] text-slate-500">Apply one plant-local window to persisted electrical analytics and export metadata.</p></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
            <span data-testid="text-applied-time-range" className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${applied.preset === 'live' ? 'border-sky-500/25 bg-sky-500/10 text-sky-300' : 'border-violet-500/25 bg-violet-500/10 text-violet-300'}`}>{timeFilterLabel(applied)}</span>
            <span className="rounded-full border border-[#1e293b] bg-[#0b0f19] px-2.5 py-1 text-[10px] text-slate-400">Plant time: {timezone}</span>
            <span className="rounded-full border border-[#1e293b] bg-[#0b0f19] px-2.5 py-1 text-[10px] text-slate-400">{applied.granularity}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 xl:max-w-xl xl:justify-end">
          {([
            ['live', 'Live'],
            ['today', 'Today'],
            ['24h', 'Last 24 h'],
            ['7d', 'Last 7 d'],
            ['custom', 'Custom'],
          ] as Array<[TimeFilterPreset, string]>).map(([preset, label]) => (
            <button key={preset} type="button" onClick={() => choosePreset(preset)} data-testid={`button-time-filter-preset-${preset}`} className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors focus-ring ${draft.preset === preset ? 'bg-blue-500/15 text-blue-300' : 'text-slate-400 hover:bg-[#1e293b] hover:text-slate-200'}`}>{label}</button>
          ))}
        </div>
      </div>
      {!isLive && <div className="mt-4 grid gap-3 border-t border-[#1e293b] pt-4 sm:grid-cols-2 xl:grid-cols-5">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Window type
          <select value={draft.mode} onChange={(event) => updateDraft({ mode: event.target.value as TimeFilterMode })} data-testid="select-time-filter-mode" className="mt-1 block w-full rounded-md border border-[#1e293b] bg-[#0b0f19] px-2.5 py-2 text-xs font-medium normal-case tracking-normal text-slate-200 focus-ring">
            <option value="single">Specific date</option><option value="range">Date range</option>
          </select>
        </label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{draft.mode === 'single' ? 'Date' : 'Start date'}
          <input type="date" value={draft.startDate} onChange={(event) => updateDraft({ startDate: event.target.value, endDate: draft.mode === 'single' ? addSiteDays(event.target.value, 1) : draft.endDate })} data-testid="input-time-filter-start-date" className="mt-1 block w-full rounded-md border border-[#1e293b] bg-[#0b0f19] px-2.5 py-2 text-xs text-slate-200 focus-ring" />
        </label>
        {draft.mode === 'range' && <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">End date
          <input type="date" value={draft.endDate} onChange={(event) => updateDraft({ endDate: event.target.value })} data-testid="input-time-filter-end-date" className="mt-1 block w-full rounded-md border border-[#1e293b] bg-[#0b0f19] px-2.5 py-2 text-xs text-slate-200 focus-ring" />
        </label>}
        <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Start time
          <input type="time" value={draft.startTime} onChange={(event) => updateDraft({ startTime: event.target.value })} data-testid="input-time-filter-start-time" className="mt-1 block w-full rounded-md border border-[#1e293b] bg-[#0b0f19] px-2.5 py-2 text-xs text-slate-200 focus-ring" />
        </label>
        <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">End time
          <input type="time" value={draft.endTime} onChange={(event) => updateDraft({ endTime: event.target.value, endDate: draft.mode === 'single' ? draft.endDate : draft.endDate })} data-testid="input-time-filter-end-time" className="mt-1 block w-full rounded-md border border-[#1e293b] bg-[#0b0f19] px-2.5 py-2 text-xs text-slate-200 focus-ring" />
        </label>
      </div>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={apply} data-testid="button-apply-time-filter" className="rounded-md bg-blue-500 px-3 py-2 text-xs font-bold text-white hover:bg-blue-400 focus-ring">Apply filter</button>
        <button type="button" onClick={reset} data-testid="button-reset-time-filter" className="rounded-md px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 focus-ring">Reset to live</button>
        <button type="button" onClick={onRefresh} data-testid="button-refresh-time-filter" className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 focus-ring"><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />Refresh</button>
        {validationError && <span role="alert" data-testid="status-time-filter-error" className="text-xs text-amber-300">{validationError}</span>}
      </div>
      <p className="mt-3 text-[10px] leading-4 text-slate-500">Historical records are scheduled snapshots only. The selected end is excluded, so adjacent windows never duplicate a sample. Live, weather, raw payload, alarm, and inverter views remain clearly current-only.</p>
    </section>
  );
}

function telemetryEpoch(row: ModbusRow) {
  const source = row.date_iso_8601 ?? row.timestamp ?? row.date;
  if (source === undefined || source === null || source === '') return null;
  const numeric = typeof source === 'number' ? source : Number(source);
  const parsed = Number.isFinite(numeric) ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric) : new Date(String(source));
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function electricalKind(row: ModbusRow): ElectricalKind | null {
  const name = String(row.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!name) return null;
  if (name.includes('powerfactor') || name === 'pf') return 'powerFactor';
  if (name.includes('frequency') || name === 'hz') return 'frequency';
  if (name.includes('activepower') || name.includes('realpower') || name === 'kw' || name.includes('kwoutput')) return 'activePower';
  if (name.includes('current')) {
    if (name.includes('phasea') || name.includes('linea') || name.includes('ia')) return 'ia';
    if (name.includes('phaseb') || name.includes('lineb') || name.includes('ib')) return 'ib';
    if (name.includes('phasec') || name.includes('linec') || name.includes('ic')) return 'ic';
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
  const reported = typeof row.data === 'number' ? row.data : typeof row.data === 'string' && row.data.trim() ? Number(row.data) : NaN;
  const scaled = Number.isFinite(reported) && explicitScalingValidated(row);
  const timestamp = telemetryEpoch(row);
  const dateTime = telemetryDateTime(row);
  const raw = row.raw_data ?? row.data;
  return {
    id: `${modbusRowKey(row)}-${timestamp ?? index}`,
    kind,
    label: String(row.name || electricalKindLabels[kind]),
    value: scaled ? reported : null,
    rawValue: raw === undefined || raw === null ? 'Data unavailable' : formatValue(raw),
    unit: typeof row.unit === 'string' && row.unit.trim() ? row.unit : telemetryUnit(row),
    timestamp,
    timestampLabel: dateTime.full,
    source: String(row.server_name || row.topic || 'Modbus'),
    address: String(row.full_addr || row.addr || 'Data unavailable'),
    quality: String(row.quality || row.data_quality || (scaled ? 'Validated scaling' : 'Scaling configuration unavailable')),
    status: raw === undefined || raw === null ? 'Data Unavailable' : scaled ? 'Validated' : 'Raw / Scaling Required',
  };
}

function formatElectricalValue(value: number | null, unit: string) {
  return value === null ? 'Data unavailable' : `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit === '—' ? '' : ` ${unit}`}`;
}

function latestEvidence(evidence: ElectricalEvidence[], kinds: ElectricalKind[]) {
  return kinds.map((kind) => evidence.filter((item) => item.kind === kind).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0]).filter(Boolean) as ElectricalEvidence[];
}

function ElectricalParametersChart({ rows, mode, timeFilter, refreshToken }: { rows: ModbusRow[]; mode: 'demo' | 'live'; timeFilter: AppliedTimeFilter; refreshToken: number }) {
  const [historyRows, setHistoryRows] = useState<ModbusRow[]>([]);
  const [historyState, setHistoryState] = useState<{ loading: boolean; error: string; truncated: boolean }>({ loading: false, error: '', truncated: false });
  const isHistorical = timeFilter.preset !== 'live';

  useEffect(() => {
    if (!isHistorical || mode !== 'live') {
      setHistoryRows([]);
      setHistoryState({ loading: false, error: '', truncated: false });
      return;
    }
    const controller = new AbortController();
    const loadHistory = async () => {
      setHistoryState({ loading: true, error: '', truncated: false });
      try {
        const response = await fetch(`/api/mqtt/electrical-history?from=${encodeURIComponent(timeFilter.from)}&to=${encodeURIComponent(timeFilter.to)}`, { signal: controller.signal });
        const payload = await response.json() as { samples?: unknown[]; message?: string; semantics?: string; truncated?: boolean };
        if (!response.ok) throw new Error(payload.message || 'Unable to load persisted electrical telemetry.');
        setHistoryRows(Array.isArray(payload.samples) ? payload.samples.filter(isUnknownRecord).map((item) => item as ModbusRow) : []);
        setHistoryState({ loading: false, error: '', truncated: payload.truncated === true });
      } catch (error) {
        if (controller.signal.aborted) return;
        setHistoryRows([]);
        setHistoryState({ loading: false, error: error instanceof Error ? error.message : 'Unable to load persisted electrical telemetry.', truncated: false });
      }
    };
    void loadHistory();
    return () => controller.abort();
  }, [timeFilter.from, timeFilter.to, isHistorical, mode, refreshToken]);

  const sourceRows = mode === 'live' ? (isHistorical ? historyRows : rows) : [];
  const discoveries = useMemo(() => sourceRows.map(electricalEvidence).filter(Boolean) as ElectricalEvidence[], [sourceRows]);
  const validated = useMemo(() => discoveries.filter((item) => item.status === 'Validated'), [discoveries]);
  const phaseVoltage = useMemo(() => latestEvidence(validated, ['vab', 'vbc', 'vca', 'va', 'vb', 'vc']), [validated]);
  const phaseCurrent = useMemo(() => latestEvidence(validated, ['ia', 'ib', 'ic']), [validated]);
  const activePower = useMemo(() => latestEvidence(validated, ['activePower'])[0], [validated]);
  const powerFactor = useMemo(() => latestEvidence(validated, ['powerFactor'])[0], [validated]);
  const frequency = useMemo(() => latestEvidence(validated, ['frequency'])[0], [validated]);
  const traceRows = useMemo(() => [...discoveries].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)), [discoveries]);
  const voltageBalance = useMemo(() => {
    if (phaseVoltage.length < 2) return null;
    const values = phaseVoltage.map((item) => item.value).filter((value): value is number => value !== null);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return average ? Math.max(...values.map((value) => Math.abs(value - average))) / average * 100 : null;
  }, [phaseVoltage]);
  const rangeLabel = timeFilterLabel(timeFilter);
  const trendData = (kind: ElectricalKind) => discoveries.filter((item) => item.kind === kind && item.status === 'Validated' && item.value !== null).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).map((item) => ({ time: item.timestamp ? formatSiteDateTime(new Date(item.timestamp).toISOString(), timeFilter.timezone) : 'Time unavailable', value: item.value }));

  const Comparison = ({ title, data, unit, testId }: { title: string; data: ElectricalEvidence[]; unit: string; testId: string }) => (
    <div className="scada-chart-surface rounded-xl border border-[#1e293b] bg-[#0b0f19] p-4" data-testid={testId}>
      <div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-xs font-bold text-slate-200">{title}</h4><span className="text-[10px] text-slate-500">Validated values only</span></div>
      {data.length ? <div className="h-36"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.map((item) => ({ name: item.label, value: item.value }))} layout="vertical" margin={{ left: 12, right: 12 }}><XAxis type="number" hide /><YAxis type="category" dataKey="name" width={92} tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip cursor={{ fill: 'var(--scada-hover)' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString()} ${unit}`, title]} /><Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} activeBar={{ fill: '#60a5fa' }} isAnimationActive={false} /></BarChart></ResponsiveContainer></div> : <p className="flex h-36 items-center justify-center text-center text-xs text-slate-500"><span>Data unavailable<span className="mt-1 block text-[10px]">A validated source value is required.</span></span></p>}
    </div>
  );
  const Trend = ({ title, kind, unit, color }: { title: string; kind: ElectricalKind; unit: string; color: string }) => {
    const data = trendData(kind);
    return <div className="scada-chart-surface rounded-xl border border-[#1e293b] bg-[#0b0f19] p-4"><div className="mb-3 flex items-center justify-between gap-3"><h4 className="text-xs font-bold text-slate-200">{title}</h4><span className="text-[10px] text-slate-500">{isHistorical ? 'Selected range' : 'Live sample'}</span></div>{data.length > 1 ? <div className="h-28"><ResponsiveContainer width="100%" height="100%"><LineChart data={data}><CartesianGrid strokeDasharray="2 4" stroke="var(--scada-border)" vertical={false} /><XAxis dataKey="time" tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} /><YAxis hide /><Tooltip cursor={{ stroke: '#64748b', strokeDasharray: '3 3' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString()} ${unit}`, title]} /><Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#f8fafc' }} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <p className="flex h-28 items-center justify-center text-center text-xs text-slate-500">{isHistorical ? 'Data unavailable for this range.' : 'Select a historical range for a trend.'}</p>}</div>;
  };

  return (
    <section className="scada-interactive-card relative flex h-full flex-col overflow-hidden rounded-xl border border-[#1e293b] bg-[#111827] p-4 sm:p-5" data-testid="section-electrical-parameters">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-transparent" />
      <header className="relative z-10 mb-4 flex flex-col gap-4 border-b border-[#1e293b] pb-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400"><PlugZap size={16} /></span><div><h3 className="text-sm font-bold text-slate-100">Electrical Parameters</h3><p className="mt-0.5 text-[11px] text-slate-500">Source-backed Modbus electrical analytics</p></div></div><p className="mt-3 max-w-2xl text-[11px] leading-5 text-slate-400">Engineering values appear only when telemetry explicitly confirms scaling. Unconfirmed inputs remain traceable as raw values and never drive charts or health indicators.</p></div>
        <CustomBadge tone={mode !== 'live' || !validated.length ? 'warning' : 'success'}>{mode !== 'live' ? 'Demo mode — not operational' : validated.length ? `${validated.length} validated value${validated.length === 1 ? '' : 's'}` : 'Validation required'}</CustomBadge>
      </header>

       <div className="relative z-10 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#1e293b] bg-[#0f1423] px-3 py-2.5" data-testid="electrical-time-filter">
         <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Applied electrical analysis window</p><p className="mt-1 truncate text-xs font-medium text-slate-300" title={rangeLabel}>{rangeLabel}</p></div>
         <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${isHistorical ? 'bg-violet-500/10 text-violet-300' : 'bg-sky-500/10 text-sky-300'}`}>{isHistorical ? 'Persisted history' : 'Live · current only'}</span>
         {historyState.error && <span role="alert" data-testid="status-electrical-history-error" className="basis-full text-xs text-amber-300">{historyState.error}</span>}
         {historyState.truncated && <span role="status" data-testid="status-electrical-history-truncated" className="basis-full text-xs text-amber-300">This range exceeds the safe history result bound; showing the earliest 5,000 persisted windows. Narrow the range for complete results.</span>}
       </div>

      {mode !== 'live' ? <div className="relative z-10 flex min-h-48 flex-1 flex-col items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/5 px-6 text-center"><AlertCircle size={26} className="mb-3 text-amber-400" /><h4 className="text-sm font-bold text-amber-200">Operational electrical analytics are unavailable in Demo mode</h4><p className="mt-2 max-w-lg text-xs leading-5 text-amber-100/70">Switch to Live Broker mode to inspect source-backed Modbus values, scaling validation, and persisted electrical history.</p></div> : <div className="relative z-10 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {([
            { title: 'Active power', evidence: activePower, context: 'Power' },
            { title: 'Power factor', evidence: powerFactor, context: 'Factor' },
            { title: 'Frequency', evidence: frequency, context: 'Hz' },
            { title: 'Phase balance', calculated: voltageBalance === null ? undefined : { value: voltageBalance, unit: '%' }, context: 'Calculated from validated phase values' },
          ] as Array<{ title: string; evidence?: ElectricalEvidence; calculated?: { value: number; unit: string }; context: string }>).map(({ title, evidence, calculated, context }) => {
            const value = evidence ? formatElectricalValue(evidence.value, evidence.unit) : calculated ? `${calculated.value.toFixed(2)} ${calculated.unit}` : 'Data unavailable';
            return <div key={title} className="scada-interactive-card rounded-xl border border-[#1e293b] bg-[#0b0f19] p-3" data-testid={`card-electrical-${title.toLowerCase().replace(/\s+/g, '-')}`} title={evidence ? `${evidence.label}\nSource: ${evidence.source}\nAddress: ${evidence.address}\nTimestamp: ${evidence.timestampLabel}\nRaw: ${evidence.rawValue}\nQuality: ${evidence.quality}` : `${title} requires validated electrical telemetry.`}><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</p><p className={`mt-2 truncate text-base font-bold ${value === 'Data unavailable' ? 'text-slate-500' : 'font-mono text-slate-100'}`}>{value}</p><p className="mt-1 truncate text-[10px] text-slate-500">{evidence ? `${evidence.status} · ${evidence.source}` : calculated ? 'Calculated only from validated phase values' : context}</p></div>;
          })}
        </div>
        <div className="grid gap-4 xl:grid-cols-2"><Comparison title="Phase Voltage Comparison" data={phaseVoltage} unit={phaseVoltage[0]?.unit || 'V'} testId="chart-phase-voltage-comparison" /><Comparison title="Phase Current Comparison" data={phaseCurrent} unit={phaseCurrent[0]?.unit || 'A'} testId="chart-phase-current-comparison" /></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Trend title="Voltage Trend" kind="vab" unit="V" color="#3b82f6" /><Trend title="Current Trend" kind="ia" unit="A" color="#10b981" /><Trend title="Active Power Trend" kind="activePower" unit="kW" color="#f59e0b" /><Trend title="Frequency Trend" kind="frequency" unit="Hz" color="#8b5cf6" /></div>
        <div className="scada-chart-surface overflow-hidden rounded-xl border border-[#1e293b] bg-[#0b0f19]"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e293b] px-4 py-3"><div><h4 className="text-xs font-bold text-slate-200">Discovered electrical telemetry</h4><p className="mt-0.5 text-[10px] text-slate-500">Raw values stay visible even when engineering scaling needs confirmation.</p></div><span data-testid="text-electrical-discovery-count" className="text-[10px] font-semibold text-slate-400">{traceRows.length} parameter{traceRows.length === 1 ? '' : 's'}</span></div><div className="max-h-64 overflow-auto scrollbar-thin"><table className="min-w-[1060px] w-full text-left"><thead className="sticky top-0 bg-[#111827]"><tr>{['Parameter', 'Current value', 'Unit', 'Timestamp', 'Source', 'Modbus address', 'Raw value', 'Data quality', 'Status'].map((heading) => <th key={heading} className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-wider text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-[#1e293b]/70">{traceRows.length ? traceRows.map((item) => <tr key={item.id} data-testid={`row-electrical-${item.id}`} title={`${item.label}\nCurrent value: ${formatElectricalValue(item.value, item.unit)}\nRaw value: ${item.rawValue}\nTimestamp: ${item.timestampLabel}\nSource: ${item.source}\nAddress: ${item.address}\nQuality: ${item.quality}\nStatus: ${item.status}`} className="scada-table-row hover:bg-[#1e293b]/40"><td className="px-3 py-2.5 text-xs font-medium text-slate-200">{item.label}</td><td className="px-3 py-2.5 font-mono text-xs text-slate-300">{formatElectricalValue(item.value, item.unit)}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.unit}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.timestampLabel}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.source}</td><td className="px-3 py-2.5 font-mono text-xs text-slate-400">{item.address}</td><td className="px-3 py-2.5 font-mono text-xs text-slate-300">{item.rawValue}</td><td className="px-3 py-2.5 text-xs text-slate-400">{item.quality}</td><td className="px-3 py-2.5"><CustomBadge tone={item.status === 'Validated' ? 'success' : 'warning'}>{item.status}</CustomBadge></td></tr>) : <tr><td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">{historyState.loading ? 'Loading persisted electrical telemetry…' : isHistorical ? 'Data unavailable for the selected range. Persisted snapshots will appear here once available.' : 'No electrical Modbus parameters have arrived yet. Values will appear automatically when the broker reports them.'}</td></tr>}</tbody></table></div></div>
      </div>}
    </section>
  );
}

function InverterOverviewTable({ devices, onOpenInverter, onViewAll, timeFilter }: { devices: Device[]; onOpenInverter: (device: Device) => void; onViewAll: () => void; timeFilter: AppliedTimeFilter }) {
  const inverters = devices.filter(d => d.type === 'Power inverter');
  return (
    <div className="scada-interactive-card bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers3 size={16} className="text-slate-400" />
          <div><h3 className="text-sm font-bold text-slate-200">Inverter Overview</h3><p className="mt-0.5 text-[9px] text-slate-500">Current-only fleet status{timeFilter.preset !== 'live' ? ' · historical filter does not change status' : ''}</p></div>
        </div>
        <button type="button" onClick={onViewAll} data-testid="button-view-all-inverters" title="Open the inverter fleet" className="text-xs text-slate-400 hover:text-slate-200 focus-ring rounded">View all</button>
      </div>
      
      <div className="flex-1 overflow-auto scrollbar-thin pr-1">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[#1e293b]">
              <th className="py-2.5 text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Inv.</th>
              <th className="py-2.5 text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Status</th>
              <th className="py-2.5 text-[9px] uppercase tracking-wider text-slate-500 font-semibold">Power</th>
              <th className="py-2.5 text-[9px] uppercase tracking-wider text-slate-500 font-semibold text-right">Temp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1e293b]/50">
            {inverters.map(inv => (
              <tr key={inv.id} onClick={() => onOpenInverter(inv)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpenInverter(inv); }} tabIndex={0} data-testid={`row-inverter-${inv.id}`} title={`Open detailed monitoring for ${inv.name}`} className="scada-table-row cursor-pointer hover:bg-[#1e293b]/30 focus:bg-[#1e293b]/30 focus:outline-none">
                <td className="py-2.5 text-[11px] font-medium text-slate-300">{inv.name.replace('Inverter ', 'INV')}</td>
                <td className="py-2.5">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${inv.status === 'online' ? 'bg-emerald-500/10 text-emerald-400' : inv.status === 'offline' ? 'bg-rose-500/10 text-rose-400' : 'bg-amber-500/10 text-amber-400'}`}>
                    <span className={`scada-status-indicator w-1 h-1 rounded-full ${inv.status === 'online' ? 'bg-emerald-400 pulse-soft' : inv.status === 'offline' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                    {inv.status}
                  </span>
                </td>
                <td className="py-2.5 text-[11px] text-slate-300">{numberFrom(inv, ['power', 'active_kw']).toLocaleString()} kW</td>
                <td className="py-2.5 text-[11px] text-slate-300 text-right">{numberFrom(inv, ['temperature', 'cabinet_c'])}°C</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      <div className="pt-3 mt-2 border-t border-[#1e293b] flex justify-between items-center text-[10px] text-slate-400">
        <span className="uppercase tracking-wider font-semibold">Total Today</span>
        <span className="font-bold text-slate-200">14.13 MWh • PF 1.000</span>
      </div>
    </div>
  );
}

function EnergySummaryChart({ timeFilter }: { timeFilter: AppliedTimeFilter }) {
  const [range, setRange] = useState<keyof typeof energyDataByRange>('daily');
  const data = energyDataByRange[range];
  const historicalUnavailable = timeFilter.preset !== 'live';
  return (
    <div className="scada-chart-surface bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex flex-col">
           <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-1">
             <Activity size={14} className="text-slate-400" /> Energy Summary
           </h3>
        </div>
        <span className={`rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${historicalUnavailable ? 'bg-amber-500/10 text-amber-300' : 'bg-sky-500/10 text-sky-300'}`}>{historicalUnavailable ? 'History unavailable' : 'Current reference'}</span>
      </div>
      {historicalUnavailable ? <div className="flex min-h-[190px] flex-1 items-center justify-center rounded-lg border border-dashed border-amber-500/25 bg-amber-500/5 px-4 text-center text-xs text-amber-200"><span>Energy history is not available from persisted electrical snapshots.<span className="mt-1 block text-[10px] text-amber-100/70">The selected range is not represented by estimated energy values.</span></span></div> : <><div className="mb-6">
        <span className="text-2xl font-bold text-slate-100 tracking-tight">{range === 'daily' ? '14.13' : range === 'monthly' ? '96.1' : '3,862'}</span> <span className="text-[11px] text-slate-500">{range === 'yearly' ? 'MWh this year' : `MWh ${range === 'daily' ? 'today' : 'this month'}`}</span>
      </div>
      <div role="tablist" aria-label="Energy time range" className="mb-3 flex w-fit bg-[#0f1423] p-0.5 rounded border border-[#1e293b]">
         {(['daily', 'monthly', 'yearly'] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={range === option} onClick={() => setRange(option)} data-testid={`button-energy-range-${option}`} className={`px-2 py-1 text-[10px] rounded font-medium capitalize focus-ring ${range === option ? 'bg-[#1e293b] text-slate-200 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>{option}</button>)}
      </div>
      <div className="flex-1 min-h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <Tooltip cursor={{ fill: 'var(--scada-hover)' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${value} MWh`, 'Energy']} />
            <Bar dataKey="value" fill="#f97316" radius={[2, 2, 0, 0]} activeBar={{ fill: '#fb923c' }} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between text-[9px] text-slate-500 mt-2 font-mono">
        <span>00</span><span>02</span><span>04</span><span>06</span><span>08</span><span>10</span><span>12</span><span>14</span><span>16</span><span>18</span><span>20</span><span>22</span>
      </div>
      </>}
    </div>
  );
}

function PowerTrendChart({ currentKw, timeFilter }: { currentKw: number; timeFilter: AppliedTimeFilter }) {
  const [range, setRange] = useState<keyof typeof powerTrendByRange>('today');
  const historicalUnavailable = timeFilter.preset !== 'live';
  return (
    <div className="scada-chart-surface bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-slate-400" />
          <h3 className="text-sm font-bold text-slate-200">Power Trend</h3>
        </div>
        <span className={`rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${historicalUnavailable ? 'bg-amber-500/10 text-amber-300' : 'bg-sky-500/10 text-sky-300'}`}>{historicalUnavailable ? 'History unavailable' : 'Current-only'}</span>
      </div>
      {historicalUnavailable ? <div className="flex min-h-[190px] flex-1 items-center justify-center rounded-lg border border-dashed border-amber-500/25 bg-amber-500/5 px-4 text-center text-xs text-amber-200"><span>Power trend history is unavailable for this filter.<span className="mt-1 block text-[10px] text-amber-100/70">Only validated electrical parameter history is currently persisted.</span></span></div> : <><div className="mb-6">
        <span className="text-2xl font-bold text-slate-100 tracking-tight">{currentKw.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> <span className="text-[11px] text-slate-500">kW right now</span>
      </div>
      <div role="tablist" aria-label="Power trend time range" className="mb-3 flex w-fit items-center rounded border border-[#1e293b] bg-[#0f1423] p-0.5">
        {(['today', 'week', 'month'] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={range === option} onClick={() => setRange(option)} data-testid={`button-power-range-${option}`} className={`rounded px-2 py-1 text-[10px] capitalize focus-ring ${range === option ? 'bg-[#1e293b] text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>{option}</button>)}
      </div>
      <div className="flex-1 min-h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={powerTrendByRange[range]} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorPower" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25}/>
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--scada-border)" vertical={false} />
            <XAxis dataKey="time" hide />
            <Tooltip cursor={{ stroke: '#64748b', strokeDasharray: '3 3' }} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} kW`, 'Plant power']} labelFormatter={(label) => `${range === 'today' ? 'Time' : 'Period'}: ${label}`} />
            <Area type="monotone" dataKey="power" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#colorPower)" activeDot={{ r: 4, stroke: '#f8fafc', strokeWidth: 2 }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between text-[9px] text-slate-500 mt-2 font-mono">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span className="text-orange-500 font-bold">Now</span>
        <span>24:00</span>
      </div>
      </>}
    </div>
  );
}

function PowerDistributionChart({ timeFilter }: { timeFilter: AppliedTimeFilter }) {
  return (
    <div className="scada-chart-surface bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center gap-2 mb-6">
        <Activity size={14} className="text-slate-400" />
        <div><h3 className="text-sm font-bold text-slate-200">Power Distribution</h3><p className="mt-0.5 text-[9px] text-slate-500">Current-only reference{timeFilter.preset !== 'live' ? ' · historical range not applied' : ''}</p></div>
      </div>
      
      <div className="flex-1 flex flex-col items-center relative">
        <div className="h-[120px] w-full relative flex justify-center mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={distributionData} innerRadius={42} outerRadius={55} paddingAngle={2} dataKey="value" stroke="none">
                {distributionData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${value}%`, 'Share of plant power']} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-sm font-bold text-slate-100">20.16</span>
            <span className="text-[7px] text-slate-500 uppercase font-bold tracking-wider mt-0.5">MW Total</span>
          </div>
        </div>
        
        <div className="w-full mt-6 space-y-2">
          {distributionData.map((entry, i) => (
            <div key={entry.name} className="flex items-center justify-between text-[10px]">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                <span className="text-slate-400 font-medium">{entry.name}</span>
              </div>
              <span className="text-slate-300 font-bold">{entry.value.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
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
    <div className="scada-interactive-card min-w-0 rounded-xl border border-[#1e293b] bg-[#0b0f19] p-3" title={detail}>
      <div className="mb-2 flex items-center gap-2">
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#1e293b]/60 ${tone}`}><Icon size={14} /></span>
        <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      </div>
      <p className={`truncate text-sm font-bold ${value === 'Data unavailable' ? 'text-slate-500' : 'text-slate-100'}`} title={value}>{value}</p>
      <p className="mt-1 truncate text-[9px] text-slate-600">{detail}</p>
    </div>
  );
}

function EnvironmentDetails({ siteName, sites = [], weather, onRefresh, onSiteChange }: {
  siteName: string;
  sites: string[];
  weather: WeatherState;
  onRefresh: () => void;
  onSiteChange: (site: string) => void;
}) {
  const current = weather.data?.current;
  const isLoading = weather.status === 'loading';
  const locationLabel = weather.location?.label ?? `${siteName} · location unavailable`;
  const observationAt = weather.data?.freshness.observationTime?.replace('T', ' ') ?? 'Data unavailable';
  const receivedAt = weather.data?.freshness.retrievedAt ? new Date(weather.data.freshness.retrievedAt).toLocaleString() : 'Data unavailable';
  const sourceLabel = weather.data ? `${weather.data.source} · ${weather.location?.source ?? 'Location unavailable'}` : 'Data unavailable';
  const siteOptions = sites.length ? sites : [siteName];
  const freshnessLabel = weather.data?.freshness.cacheStatus === 'cached' ? 'Cached response' : weather.data ? 'Fresh response' : 'Data unavailable';
  const weatherIcon = current?.weatherCondition?.toLowerCase().includes('rain') || current?.weatherCondition?.toLowerCase().includes('drizzle') ? CloudRain : current?.weatherCondition?.toLowerCase().includes('clear') ? Sun : CloudSun;
  const WeatherIcon = weatherIcon;
  const windDegrees = current?.windDirectionDeg;
  const percentWidth = (value: number | null | undefined) => value === null || value === undefined ? 0 : Math.max(0, Math.min(100, value));
  const metricDetail = (label: string) => `${label} · ${siteName} · observed ${observationAt} · source ${sourceLabel} · ${freshnessLabel}`;
  const temperatureTrend = weather.data?.temperatureTrend ?? [];

  return (
    <section id="environment" data-section="environment" className="scada-interactive-card scroll-mt-6 overflow-hidden rounded-xl border border-[#1e293b] bg-[#111827]">
      <div className="border-b border-[#1e293b] bg-gradient-to-r from-orange-500/[0.08] via-transparent to-blue-500/[0.06] p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-orange-500/20 bg-orange-500/10 text-orange-400"><CloudSun size={17} /></span>
              <h2 className="text-sm font-bold text-slate-100">Environment Details</h2>
              <span data-testid="status-weather" className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${weather.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400' : weather.status === 'stale' ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-500/10 text-amber-400'}`}><span className={`h-1.5 w-1.5 rounded-full ${weather.status === 'ready' ? 'bg-emerald-400 pulse-soft' : 'bg-amber-400'}`} />{weather.status === 'ready' ? 'Live weather' : weather.status === 'stale' ? 'Stale data' : isLoading ? 'Refreshing' : 'Data unavailable'}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <label className="flex items-center gap-2"><MapPin size={13} className="text-orange-400" /><span className="font-semibold text-slate-500">Plant/site</span><select value={siteName} onChange={(event) => onSiteChange(event.target.value)} data-testid="select-environment-site" className="max-w-[210px] truncate rounded-md border border-[#1e293b] bg-[#0b0f19] px-2 py-1.5 text-xs font-semibold text-slate-200 focus-ring">{siteOptions.map((site) => <option key={site} value={site}>{site}</option>)}</select></label>
              <span className="h-4 w-px bg-[#1e293b]" />
              <span className="truncate" title={locationLabel}><LocateFixed size={13} className="mr-1 inline text-slate-500" />{locationLabel}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className="rounded-lg border border-[#1e293b] bg-[#0b0f19] px-2.5 py-1.5 text-slate-400" title="Configured site/device weather provenance">Source: {sourceLabel}</span>
            <span className="rounded-lg border border-[#1e293b] bg-[#0b0f19] px-2.5 py-1.5 text-slate-400" title="Weather provider observation timestamp">Observed: {observationAt}</span>
            <span className={`rounded-lg border border-[#1e293b] px-2.5 py-1.5 ${weather.data?.freshness.cacheStatus === 'cached' ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'}`} title="Data freshness state">{freshnessLabel}</span>
            <button type="button" onClick={onRefresh} data-testid="button-refresh-weather" title="Refresh weather for the selected configured site" className="inline-flex items-center gap-1.5 rounded-lg border border-[#1e293b] px-2.5 py-1.5 font-semibold text-slate-300 hover:bg-[#1e293b] focus-ring"><RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} /> Refresh</button>
          </div>
        </div>
      </div>
      {weather.status === 'unavailable' && <div role="status" data-testid="status-weather-unavailable" className="mx-4 mt-4 flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-3 text-xs text-amber-300 sm:mx-5"><AlertCircle size={15} className="mt-0.5 shrink-0" /><div><p className="font-semibold">Weather data unavailable for this site</p><p className="mt-1 text-amber-200/70">{weather.message ?? 'No configured site or registered device coordinates are available.'}</p></div></div>}

      <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[#1e293b] bg-[#0b0f19] p-4 sm:col-span-2">
            <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Configured site context</p><p className="mt-1 text-base font-bold text-slate-100">{siteName}</p><p className="mt-1 text-xs text-slate-400">{weather.location?.deviceName ? `Device/inverter location: ${weather.location.deviceName}` : 'Device/inverter location: Data unavailable'}</p></div><MapPin size={18} className="text-orange-400" /></div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg bg-[#111827] p-2.5"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Latitude</span><span className="mt-1 block font-mono font-semibold text-slate-200">{weather.location?.latitude.toFixed(5) ?? 'Data unavailable'}</span></div><div className="rounded-lg bg-[#111827] p-2.5"><span className="block text-[9px] uppercase tracking-wider text-slate-500">Longitude</span><span className="mt-1 block font-mono font-semibold text-slate-200">{weather.location?.longitude.toFixed(5) ?? 'Data unavailable'}</span></div></div>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-blue-500/15 bg-blue-500/5 px-3 py-2 text-[10px] text-blue-200/80"><LocateFixed size={13} className="text-blue-400" /> SCADA site coordinates are the only weather location source.</div>
          </div>
          <div className="rounded-xl border border-[#1e293b] bg-[#0b0f19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Live condition</p><p className="mt-2 text-lg font-bold text-slate-100">{current?.weatherCondition ?? 'Data unavailable'}</p></div><span className="grid h-11 w-11 place-items-center rounded-full border border-orange-500/20 bg-orange-500/10 text-orange-300"><WeatherIcon size={24} /></span></div><p className="mt-3 text-[10px] text-slate-500">{metricDetail('Weather condition')}</p></div>
          <div className="rounded-xl border border-[#1e293b] bg-[#0b0f19] p-4"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Wind compass</p><p className="mt-2 text-lg font-bold text-slate-100">{weatherMetricValue(current?.windSpeedMs, 'm/s')}</p></div><div className="relative grid h-12 w-12 place-items-center rounded-full border border-[#334155] bg-[#111827] text-[8px] text-slate-500"><span className="absolute top-1">N</span><span className="absolute bottom-1">S</span><span className="absolute left-1">W</span><span className="absolute right-1">E</span><span className="h-0.5 w-7 origin-center bg-blue-400" style={{ transform: `rotate(${windDegrees ?? 0}deg)` }} /><span className="absolute h-2 w-2 rounded-full bg-blue-400" /></div></div><p className="mt-3 text-[10px] text-slate-500">{windDirection(windDegrees) ?? 'Direction unavailable'} · {metricDetail('Wind')}</p></div>
        </div>

        <div className="rounded-xl border border-[#1e293b] bg-[#0b0f19] p-4">
          <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Temperature trend</p><p className="mt-1 text-xs text-slate-400">Provider observations in {weather.data?.location.timezone ?? 'site timezone'}</p></div><Thermometer size={17} className="text-rose-400" /></div>
          {temperatureTrend.length > 1 ? <div className="mt-3 h-40"><ResponsiveContainer width="100%" height="100%"><AreaChart data={temperatureTrend} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}><defs><linearGradient id="environmentTemperature" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#fb7185" stopOpacity={0.28} /><stop offset="95%" stopColor="#fb7185" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="2 4" stroke="var(--scada-border)" vertical={false} /><XAxis dataKey="time" tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} tickFormatter={(value) => String(value).slice(11, 16)} /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 9 }} tickFormatter={(value) => `${value}°`} width={32} /><Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemStyle={CHART_ITEM_STYLE} formatter={(value) => [`${Number(value).toFixed(1)} °C`, 'Temperature']} /><Area type="monotone" dataKey="temperatureC" stroke="#fb7185" strokeWidth={2} fill="url(#environmentTemperature)" isAnimationActive={false} /></AreaChart></ResponsiveContainer></div> : <div className="mt-3 flex h-40 items-center justify-center rounded-lg border border-dashed border-[#1e293b] text-center text-xs text-slate-500">Data unavailable<br /><span className="text-[10px]">No provider temperature trend returned.</span></div>}
          <p className="mt-2 text-[10px] text-slate-500">{metricDetail('Temperature trend')} · Last updated {receivedAt}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-[#1e293b] p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-3 xl:grid-cols-4">
        <EnvironmentMetric icon={Thermometer} label="Temperature" value={weatherMetricValue(current?.temperatureC, '°C')} tone="text-rose-400" detail={metricDetail('Temperature')} />
        <EnvironmentMetric icon={Wind} label="Wind speed" value={weatherMetricValue(current?.windSpeedMs, 'm/s')} tone="text-blue-400" detail={metricDetail('Wind speed')} />
        <EnvironmentMetric icon={LocateFixed} label="Wind direction" value={windDirection(current?.windDirectionDeg) ?? 'Data unavailable'} tone="text-indigo-400" detail={metricDetail('Wind direction')} />
        <EnvironmentMetric icon={Droplets} label="Humidity" value={weatherMetricValue(current?.humidityPct, '%', 0)} tone="text-cyan-400" detail={metricDetail('Humidity')} />
        <EnvironmentMetric icon={Sun} label="Solar irradiance" value={weatherMetricValue(current?.irradianceWm2, 'W/m²', 0)} tone="text-orange-400" detail={metricDetail('Solar irradiance')} />
        <EnvironmentMetric icon={CloudSun} label="Cloud cover" value={weatherMetricValue(current?.cloudCoverPct, '%', 0)} tone="text-slate-400" detail={metricDetail('Cloud cover')} />
        <EnvironmentMetric icon={CloudRain} label="Precipitation" value={weatherMetricValue(current?.precipitationMm, 'mm')} tone="text-sky-400" detail={metricDetail('Precipitation')} />
        <EnvironmentMetric icon={MapPin} label="Weather timezone" value={weather.data?.location.timezone ?? 'Data unavailable'} tone="text-emerald-400" detail={metricDetail('Weather timezone')} />
      </div>
      {current && <div className="grid gap-3 border-t border-[#1e293b] bg-[#0f1423] p-4 sm:grid-cols-3 sm:p-5"><div><div className="mb-1 flex justify-between text-[10px]"><span className="font-semibold text-slate-400">Humidity indicator</span><span className="font-mono text-slate-300">{weatherMetricValue(current.humidityPct, '%', 0)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#1e293b]"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${percentWidth(current.humidityPct)}%` }} /></div></div><div><div className="mb-1 flex justify-between text-[10px]"><span className="font-semibold text-slate-400">Cloud cover</span><span className="font-mono text-slate-300">{weatherMetricValue(current.cloudCoverPct, '%', 0)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#1e293b]"><div className="h-full rounded-full bg-slate-400" style={{ width: `${percentWidth(current.cloudCoverPct)}%` }} /></div></div><div><div className="mb-1 flex justify-between text-[10px]"><span className="font-semibold text-slate-400">Precipitation</span><span className="font-mono text-slate-300">{weatherMetricValue(current.precipitationMm, 'mm')}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#1e293b]"><div className="h-full rounded-full bg-sky-400" style={{ width: `${percentWidth(current.precipitationMm === null ? null : Math.min(100, current.precipitationMm * 10))}%` }} /></div></div></div>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#1e293b] px-4 py-3 text-[10px] text-slate-500 sm:px-5"><span>Weather data source: <strong className="font-semibold text-slate-300">{weather.data?.source ?? 'Data unavailable'}</strong></span><span>Last updated: <strong className="font-semibold text-slate-300">{receivedAt}</strong></span><span>Site: <strong className="font-semibold text-slate-300">{siteName}</strong></span></div>
    </section>
  );
}

function SidePanels({ timeFilter }: { timeFilter: AppliedTimeFilter }) {
  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="scada-interactive-card bg-[#111827] border border-[#1e293b] rounded-xl p-4 flex-1">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={14} className="text-slate-400" />
          <div><h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Alarms & Faults</h3><p className="mt-0.5 text-[9px] text-slate-500">Current-only{timeFilter.preset !== 'live' ? ' · not historical events' : ''}</p></div>
        </div>
        <div className="space-y-2.5">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">General Alarm</span>
            <span className="font-bold text-slate-200">0</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Fault Alarm</span>
            <span className="font-bold text-slate-200">0</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Fault Code</span>
            <span className="font-bold text-slate-200">0</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Alarm Code</span>
            <span className="font-bold text-slate-200">65535</span>
          </div>
        </div>
      </div>
      
      <div className="scada-interactive-card bg-[#111827] border border-[#1e293b] rounded-xl p-4 flex-1">
        <div className="flex items-center gap-2 mb-3">
          <Check size={14} className="text-slate-400" />
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Data Quality</h3>
        </div>
        <div className="flex items-center gap-4">
           <div className="relative w-[52px] h-[52px] flex items-center justify-center">
             <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#1e293b" strokeWidth="3.5" />
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#10b981" strokeWidth="3.5" strokeDasharray="92, 100" />
             </svg>
             <span className="absolute text-[10px] font-bold text-emerald-400">92%</span>
           </div>
           <div className="space-y-2 flex-1">
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /><span className="text-slate-400">Good</span></div>
               <span className="text-slate-200 font-bold">35</span>
             </div>
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /><span className="text-slate-400">Scaling</span></div>
               <span className="text-slate-200 font-bold">3</span>
             </div>
             <div className="flex items-center justify-between text-[9px]">
               <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" /><span className="text-slate-400">Bad</span></div>
               <span className="text-slate-200 font-bold">0</span>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}

function DetailedLiveDataTable({ rows, persistence, timeFilter }: { rows: ModbusRow[]; persistence: PersistenceStatus; timeFilter: AppliedTimeFilter }) {
  const [filter, setFilter] = useState('');
  const [filterCategory, setFilterCategory] = useState('All categories');
  const [filterSource, setFilterSource] = useState('All sources');
  const [sortKey, setSortKey] = useState<TelemetrySortKey>('parameter');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [exportMessage, setExportMessage] = useState('');
  const categories = ['All categories', 'Electrical', 'Power', 'Environment', 'Alarms', 'Device'];
  const sources = useMemo(() => ['All sources', ...Array.from(new Set(rows.map((row) => String(row.server_name || 'Modbus'))).values()).sort()], [rows]);
  const filteredRows = useMemo(() => rows.filter((row) => {
    const dateTime = telemetryDateTime(row);
    const searchable = `${row.name ?? ''} ${row.full_addr ?? row.addr ?? ''} ${row.server_name ?? ''} ${row.data ?? ''} ${dateTime.date} ${dateTime.time}`.toLowerCase();
    return searchable.includes(filter.toLowerCase()) &&
      (filterCategory === 'All categories' || telemetryCategory(row) === filterCategory) &&
      (filterSource === 'All sources' || String(row.server_name || 'Modbus') === filterSource);
  }), [rows, filter, filterCategory, filterSource]);
  const sortedRows = useMemo(() => [...filteredRows].sort((a, b) => {
    const dateA = telemetryDateTime(a);
    const dateB = telemetryDateTime(b);
    const values: Record<TelemetrySortKey, (row: ModbusRow) => string | number> = {
      category: telemetryCategory,
      parameter: (row) => String(row.name || ''),
      raw: (row) => String(row.raw_data ?? row.data ?? ''),
      scaled: (row) => String(row.data ?? ''),
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
  const lastSnapshotLabel = persistence.lastSnapshotAt
    ? `${persistence.lastSnapshotStatus === 'missing' ? 'Missing window' : 'Saved'} · ${formatInPlantTimezone(persistence.lastSnapshotScheduledFor ?? persistence.lastSnapshotAt, persistence.timezone)}`
    : 'No scheduled snapshot recorded yet';
  const timeScopeLabel = timeFilterLabel(timeFilter);
  const resetFilters = () => {
    setFilter('');
    setFilterCategory('All categories');
    setFilterSource('All sources');
  };
  const exportExcel = () => {
    const title = `TRN246 Solar Plant — Detailed Live Data (${new Date().toLocaleString()})`;
    const columns = ['Category', 'Parameter', 'Raw Value', 'Customer Value', 'Unit', 'Register Address', 'Data Quality', 'Source', 'Date', 'Time'];
    const cell = (value: unknown) => `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
    const reportRows = [
      `<Row>${cell(title)}</Row>`,
      `<Row>${cell(`Time scope: ${timeScopeLabel} | Current-only table: yes | Filter: ${filter || 'All parameters'} | Category: ${filterCategory} | Source: ${filterSource} | Sort: ${sortLabel} | Rows: ${sortedRows.length}`)}</Row>`,
      `<Row>${columns.map(cell).join('')}</Row>`,
      ...sortedRows.map((row) => {
        const dateTime = telemetryDateTime(row);
        return `<Row>${[
          telemetryCategory(row), row.name || '—', row.raw_data ?? row.data, row.data, telemetryUnit(row),
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
      return `<tr><td>${escapeHtml(telemetryCategory(row))}</td><td>${escapeHtml(row.name || '—')}</td><td>${escapeHtml(row.raw_data ?? row.data)}</td><td>${escapeHtml(row.data)}</td><td>${escapeHtml(telemetryUnit(row))}</td><td>${escapeHtml(row.full_addr ?? row.addr ?? '—')}</td><td>${escapeHtml(row.quality ?? 'Good')}</td><td>${escapeHtml(row.server_name || 'Modbus')}</td><td>${escapeHtml(dateTime.date)}</td><td>${escapeHtml(dateTime.time)}</td></tr>`;
    }).join('');
    reportWindow.document.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>
      @page{size:landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#172033;font-size:10px}h1{font-size:18px;margin:0 0 4px}p{margin:3px 0;color:#5c6b80}.meta{border-bottom:2px solid #dbe3ef;padding-bottom:10px;margin-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#e8eef7;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em}th,td{border:1px solid #dbe3ef;padding:6px 5px;vertical-align:top}td:nth-child(3),td:nth-child(4),td:nth-child(6),td:nth-child(10){font-family:monospace} .empty{text-align:center;padding:24px;color:#5c6b80}@media print{thead{display:table-header-group}tr{break-inside:avoid}}
    </style></head><body><div class="meta"><h1>${escapeHtml(title)}</h1><p>Generated: ${escapeHtml(new Date().toLocaleString())}</p><p>Time scope: ${escapeHtml(timeScopeLabel)} · Current-only table: yes</p><p>Filter: ${escapeHtml(filter || 'All parameters')} · Category: ${escapeHtml(filterCategory)} · Source: ${escapeHtml(filterSource)} · Sort: ${escapeHtml(sortLabel)} · Rows: ${sortedRows.length}</p></div><table><thead><tr>${['Category', 'Parameter', 'Raw Value', 'Customer Value', 'Unit', 'Register Address', 'Data Quality', 'Source', 'Date', 'Time'].map((heading) => `<th>${heading}</th>`).join('')}</tr></thead><tbody>${htmlRows || '<tr><td class="empty" colspan="10">No telemetry rows match the current filters.</td></tr>'}</tbody></table></body></html>`);
    reportWindow.document.close();
    reportWindow.focus();
    window.setTimeout(() => reportWindow.print(), 250);
    setExportMessage(`PDF report opened with ${sortedRows.length} filtered row${sortedRows.length === 1 ? '' : 's'}. Use the print dialog to save it as PDF.`);
  };
  const sortButton = (key: TelemetrySortKey, label: string) => <button type="button" onClick={() => handleSort(key)} aria-label={`Sort by ${label}; currently ${key === sortKey ? sortLabel : 'not sorted'}`} aria-sort={key === sortKey ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} data-testid={`button-sort-${key}`} className="inline-flex items-center gap-1 rounded px-1 py-1 text-left hover:bg-[#1e293b]/60 hover:text-slate-300 focus-ring">{label}<span aria-hidden="true" className={key === sortKey ? 'text-blue-400' : 'text-slate-600'}>{key === sortKey ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span></button>;
  
  return (
    <section id="live-data" data-section="live-data" className="bg-[#111827] border border-[#1e293b] rounded-xl overflow-hidden flex flex-col mt-6">
      <div className="flex flex-col justify-between gap-4 border-b border-[#1e293b] p-5 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Database size={16} className="text-slate-400" />
            <h3 className="text-sm font-bold text-slate-200">Detailed Live Data</h3>
          </div>
           <p className="text-xs text-slate-500">Live MQTT/SSE data updates 24/7. This table is current-only; historical electrical samples appear in Electrical Parameters.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span data-testid="status-live-telemetry" className="rounded bg-sky-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-sky-300">Live · 24/7</span>
          <span className={`rounded px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider ${persistence.error ? 'bg-rose-500/10 text-rose-400' : 'bg-[#1e293b] text-slate-300'}`}>
            {persistence.error ? 'Historical storage retrying' : persistence.savingActive ? `Historical saving · every ${persistence.intervalMinutes} min` : 'Historical saving paused'}
          </span>
          <button type="button" onClick={exportExcel} data-testid="button-export-excel" title="Download the filtered and sorted telemetry as an Excel workbook" className="inline-flex items-center gap-1.5 rounded border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 focus-ring"><Download size={13} /> Excel</button>
          <button type="button" onClick={exportPdf} data-testid="button-export-pdf" title="Open a detailed filtered telemetry report ready to save as PDF" className="inline-flex items-center gap-1.5 rounded border border-rose-500/25 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 focus-ring"><FileText size={13} /> PDF</button>
        </div>
      </div>
      <div data-testid="status-historical-persistence" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[#1e293b] bg-[#0b0f19] px-5 py-2 text-[10px] text-slate-500">
        <span><strong className="font-semibold text-slate-300">Saved historical data:</strong> {scheduleLabel}</span>
        <span><strong className="font-semibold text-slate-300">Next window:</strong> {formatInPlantTimezone(persistence.nextScheduledAt, persistence.timezone)}</span>
        <span><strong className="font-semibold text-slate-300">Last record:</strong> {lastSnapshotLabel}</span>
      </div>
      {timeFilter.preset !== 'live' && <div data-testid="status-live-table-current-only" className="border-b border-violet-500/20 bg-violet-500/5 px-5 py-2 text-[10px] text-violet-200">Selected range: {timeScopeLabel}. This live table remains current-only and is not substituted for persisted history.</div>}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#1e293b] bg-[#0f1423] p-4">
        <label className="relative min-w-[220px] flex-1 sm:flex-none">
          <span className="sr-only">Search live Modbus data</span>
          <Search size={14} aria-hidden="true" className="absolute left-3 top-2.5 text-slate-500" />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="input-filter-live-data" placeholder="Search parameter, address, source, date..." className="w-full rounded-lg border border-[#1e293b] bg-[#0b0f19] py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-500 focus-ring" />
        </label>
        <label>
          <span className="sr-only">Filter by telemetry category</span>
          <select value={filterCategory} onChange={(event) => setFilterCategory(event.target.value)} data-testid="select-filter-category" className="rounded-lg border border-[#1e293b] bg-[#0b0f19] px-3 py-2 text-xs text-slate-300 focus-ring">
            {categories.map((category) => <option key={category}>{category}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by telemetry source</span>
          <select value={filterSource} onChange={(event) => setFilterSource(event.target.value)} data-testid="select-filter-source" className="max-w-[180px] rounded-lg border border-[#1e293b] bg-[#0b0f19] px-3 py-2 text-xs text-slate-300 focus-ring">
            {sources.map((source) => <option key={source}>{source}</option>)}
          </select>
        </label>
        {(filter || filterCategory !== 'All categories' || filterSource !== 'All sources') && <button type="button" onClick={resetFilters} data-testid="button-clear-live-filters" className="rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 focus-ring">Clear filters</button>}
        <span role="status" data-testid="text-live-data-count" className="ml-auto text-xs text-slate-400">{sortedRows.length} of {rows.length} parameters</span>
      </div>
      {exportMessage && <div role="status" data-testid="status-export-message" className="border-b border-[#1e293b] bg-blue-500/5 px-5 py-2.5 text-xs text-blue-300">{exportMessage}</div>}
      
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-left whitespace-nowrap min-w-[1260px]">
          <thead className="bg-[#0b0f19]">
            <tr>
              {[
                ['category', 'Category'], ['parameter', 'Parameter'], ['raw', 'Raw Value'], ['scaled', 'Customer Value'],
                ['unit', 'Unit'], ['address', 'Register Address'], ['date', 'Date'], ['time', 'Time'], ['source', 'Source'],
              ].map(([key, label]) => <th key={key} className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">{sortButton(key as TelemetrySortKey, label)}</th>)}
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Data Quality</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1e293b]">
            {sortedRows.length ? sortedRows.map((row, index) => {
               const rawValue = formatValue(row.raw_data ?? row.data);
               const scaledValue = formatValue(row.data);
               const dateTime = telemetryDateTime(row);
               return (
                   <tr key={`${modbusRowKey(row)}-${index}`} data-testid={`row-live-data-${index}`} title={`${String(row.name || 'Parameter')}\nCustomer value: ${scaledValue} ${telemetryUnit(row)}\nRaw value: ${rawValue}\nModbus address: ${String(row.full_addr || row.addr || '—')}\nSource: ${String(row.server_name || 'Modbus')}\nQuality: ${String(row.quality || 'Good')}\nDate: ${dateTime.date}\nTime: ${dateTime.time}`} className="hover:bg-[#1e293b]/40 transition-colors">
                   <td className="px-5 py-2.5 text-[11px] text-slate-300 flex items-center gap-2">
                     <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      {telemetryCategory(row)}
                   </td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-300 font-medium">{String(row.name || '—')}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{rawValue}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-200 font-mono font-bold">{scaledValue}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400">{telemetryUnit(row)}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{String(row.full_addr || row.addr || '—')}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400">{dateTime.date}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{dateTime.time}</td>
                    <td className="px-5 py-2.5 text-[11px] text-slate-400">{String(row.server_name || 'Modbus')}</td>
                   <td className="px-5 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${String(row.quality || 'Good').toLowerCase() === 'good' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'}`}>
                        <span className="w-1 h-1 rounded-full bg-current" /> {String(row.quality || 'Good')}
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

function CompletePayloadInspector({ rawPayload, rawJson, topic, onCopy, timeFilter }: { rawPayload: string; rawJson: JsonValue | null; topic: string; onCopy: (payload: string) => void; timeFilter: AppliedTimeFilter }) {
  const rows = rawJson ? flattenJson(rawJson) : [];
  return (
    <section id="raw-data" data-section="raw-data" className="scada-interactive-card bg-[#111827] border border-[#1e293b] rounded-xl overflow-hidden mt-6">
      <div className="flex flex-col justify-between gap-3 border-b border-[#1e293b] p-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-3 mb-1">
             <Code2 size={16} className="text-slate-400" />
             <h3 className="text-sm font-bold text-slate-200">Raw MQTT Payload</h3>
             <CustomBadge tone="success"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-soft" />Live</CustomBadge>
          </div>
           <p className="text-[11px] text-slate-500 font-mono mt-1">{topic}</p>
           {timeFilter.preset !== 'live' && <p data-testid="status-raw-payload-current-only" className="mt-1 text-[10px] text-violet-300">Current-only message · selected historical range does not alter this raw payload.</p>}
        </div>
        <button type="button" onClick={() => onCopy(rawPayload)} data-testid="button-copy-raw-payload" title="Copy the exact MQTT message without formatting changes" className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e293b] text-[11px] font-medium text-slate-200 hover:bg-slate-700 transition-colors border border-[#334155] focus-ring">
          <Copy size={13} /> Copy Exact Message
        </button>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-[#1e293b]">
        <div className="p-5 flex flex-col max-h-[400px]">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-3">Exact JSON Message</p>
          <div className="flex-1 overflow-auto bg-[#0b0f19] rounded-lg border border-[#1e293b] p-3 scrollbar-thin">
             <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed">{rawPayload}</pre>
          </div>
        </div>
        <div className="p-5 flex flex-col max-h-[400px]">
          <div className="flex items-center justify-between mb-3">
             <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Discovered Fields</p>
             <span className="text-[9px] font-medium text-slate-400 bg-[#1e293b] px-2 py-0.5 rounded">{rows.length} fields</span>
          </div>
          <div className="flex-1 overflow-auto border border-[#1e293b] rounded-lg scrollbar-thin">
             <table className="w-full text-left">
               <thead className="bg-[#0b0f19] sticky top-0 border-b border-[#1e293b]">
                 <tr>
                   <th className="px-3 py-2 text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Path</th>
                   <th className="px-3 py-2 text-[9px] font-semibold text-slate-500 uppercase tracking-wider">Value</th>
                 </tr>
               </thead>
               <tbody className="divide-y divide-[#1e293b]/50">
                 {rows.map((row, i) => (
                    <tr key={i} className="scada-table-row hover:bg-[#1e293b]/30">
                     <td className="px-3 py-2 text-[11px] text-blue-400 font-mono whitespace-nowrap">{row.path}</td>
                     <td className="px-3 py-2 text-[11px] text-slate-300 font-mono truncate max-w-[200px]">{row.value}</td>
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

function BrokerPanel({ open, onClose, mode, setMode, connected, onConnect, onDisconnect, error }: any) {
  const [url, setUrl] = useState(() => localStorage.getItem('northline-broker-url') || DEFAULT_BROKER_URL);
  const [topic, setTopic] = useState(() => localStorage.getItem('northline-broker-topic') || DEFAULT_BROKER_TOPIC);
  const dialogRef = useModalAccessibility(onClose, open);
  const handleConnect = () => { localStorage.setItem('northline-broker-url', url); localStorage.setItem('northline-broker-topic', topic); onConnect(url, topic); };
  if (!open) return null;
  
  return (
    <>
      <button type="button" aria-label="Close broker settings" onClick={onClose} className="fixed inset-0 z-40 bg-[#0b0f19]/80 backdrop-blur-sm cursor-default" />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="telemetry-settings-title" tabIndex={-1} className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[min(400px,100vw)] flex-col border-l border-[#1e293b] bg-[#111827] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1e293b] px-4 py-5 sm:px-6">
          <div>
            <h2 id="telemetry-settings-title" className="text-lg font-bold text-slate-100 tracking-tight">Settings</h2>
            <p className="text-xs text-slate-400 mt-1">Configure telemetry connection</p>
          </div>
           <button type="button" aria-label="Close settings" data-testid="button-close-settings" title="Close settings" onClick={onClose} className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] rounded-lg transition-colors focus-ring">
            <X size={18} />
          </button>
        </div>
        
        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-6 scrollbar-thin sm:px-6">
          <div className="bg-[#0b0f19] border border-[#1e293b] p-1.5 rounded-lg flex gap-1">
             <button type="button" onClick={() => setMode('demo')} data-testid="button-mode-demo" className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-md transition-colors focus-ring ${mode === 'demo' ? 'bg-[#1e293b] text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}><Play size={14} /> Demo Stream</button>
             <button type="button" onClick={() => setMode('live')} data-testid="button-mode-live" className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-md transition-colors focus-ring ${mode === 'live' ? 'bg-[#1e293b] text-emerald-400' : 'text-slate-400 hover:text-slate-200'}`}><Wifi size={14} /> Live Broker</button>
          </div>
          
          <div className="space-y-4">
            <label className="block">
               <span className="block text-xs font-bold text-slate-300 mb-2">Broker Endpoint</span>
               <div className="relative">
                 <Link2 size={15} className="absolute left-3 top-3.5 text-slate-500" />
                  <input aria-label="Broker endpoint" data-testid="input-broker-endpoint" value={url} onChange={e => setUrl(e.target.value)} className="w-full bg-[#0b0f19] border border-[#1e293b] text-slate-200 text-xs py-3 pl-9 pr-3 rounded-lg focus:outline-none focus:border-blue-500 font-mono" />
               </div>
            </label>
            <label className="block">
               <span className="block text-xs font-bold text-slate-300 mb-2">Subscription Topic</span>
               <div className="relative">
                 <Radio size={15} className="absolute left-3 top-3.5 text-slate-500" />
                  <input aria-label="Subscription topic" data-testid="input-broker-topic" value={topic} onChange={e => setTopic(e.target.value)} className="w-full bg-[#0b0f19] border border-[#1e293b] text-slate-200 text-xs py-3 pl-9 pr-3 rounded-lg focus:outline-none focus:border-blue-500 font-mono" />
               </div>
            </label>
          </div>
          
          {error && (
            <div className="flex gap-3 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-lg">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
        
        <div className="border-t border-[#1e293b] bg-[#111827] p-4 sm:p-6">
          {connected ? (
             <button type="button" onClick={onDisconnect} data-testid="button-disconnect-broker" className="w-full flex items-center justify-center gap-2 py-3 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 text-sm font-bold rounded-lg transition-colors focus-ring"><WifiOff size={16} /> Disconnect</button>
          ) : (
             <button type="button" onClick={handleConnect} data-testid="button-connect-broker" className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-lg shadow-lg shadow-blue-500/20 transition-colors focus-ring"><PlugZap size={16} /> {mode === 'demo' ? 'Start Demo' : 'Connect to Broker'}</button>
          )}
        </div>
      </section>
    </>
  );
}

function InverterDetailPanel({ device, onClose }: { device: Device; onClose: () => void }) {
  const [tab, setTab] = useState('Overview');
  const dialogRef = useModalAccessibility(onClose);
  const tabs = ['Overview', 'Live Power', 'Electrical', 'Energy', 'MPPT', 'Strings', 'Temperature', 'Alarms', 'Faults', 'Historical', 'Raw Data', 'Data Quality'];
  const activePower = numberFrom(device, ['power', 'active_kw']);
  const cabinetTemp = numberFrom(device, ['temperature', 'cabinet_c']);
  const voltage = numberFrom(device, ['dc_bus', 'voltage_v']);
  const current = numberFrom(device, ['dc_bus', 'current_a']);
  const rawRows = flattenJson(device.telemetry);
  const reportedTabs = ['Overview', 'Live Power', 'Electrical', 'Temperature', 'Alarms', 'Raw Data', 'Data Quality'];

  return (
    <>
      <button type="button" aria-label="Close inverter details" onClick={onClose} className="fixed inset-0 z-40 cursor-default bg-[#0b0f19]/75 backdrop-blur-sm" />
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${device.name} monitoring details`} tabIndex={-1} className="fixed inset-x-3 bottom-3 top-3 z-50 mx-auto flex max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#1e293b] bg-[#111827] shadow-2xl sm:inset-x-8 sm:bottom-8 sm:top-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1e293b] px-5 py-4 sm:px-6">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Inverter fleet / {device.site}</p>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-slate-100">{device.name}</h2>
              <CustomBadge tone={device.status === 'online' ? 'success' : device.status === 'offline' ? 'destructive' : 'warning'}>{device.status}</CustomBadge>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close inverter details" data-testid="button-close-inverter-details" title="Close inverter details" className="rounded-lg p-2 text-slate-400 hover:bg-[#1e293b] hover:text-slate-100 focus-ring"><X size={20} /></button>
        </header>
        <nav aria-label="Inverter detail sections" className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-[#1e293b] px-4 py-2">
          {tabs.map((item) => <button key={item} type="button" onClick={() => setTab(item)} data-testid={`button-inverter-tab-${item.toLowerCase().replace(/\s+/g, '-')}`} className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition-colors focus-ring ${tab === item ? 'bg-[#1e293b] text-slate-100' : 'text-slate-400 hover:bg-[#1e293b]/60 hover:text-slate-200'}`}>{item}</button>)}
        </nav>
        <div className="scrollbar-thin flex-1 overflow-y-auto p-4 sm:p-6">
          {reportedTabs.includes(tab) ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Active power', `${activePower.toLocaleString()} kW`, 'Latest customer value'],
                  ['DC bus voltage', voltage ? `${voltage.toLocaleString()} V` : 'Not reported', 'Modbus-normalized value'],
                  ['DC bus current', current ? `${current.toLocaleString()} A` : 'Not reported', 'Modbus-normalized value'],
                  ['Cabinet temperature', cabinetTemp ? `${cabinetTemp} °C` : 'Not reported', `Last seen ${new Date(device.lastSeen).toLocaleTimeString()}`],
                ].map(([label, value, context]) => <div key={label} className="rounded-xl border border-[#1e293b] bg-[#0f1423] p-4"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-2 text-lg font-bold text-slate-100">{value}</p><p className="mt-1 text-xs text-slate-400">{context}</p></div>)}
              </div>
              {tab === 'Raw Data' ? (
                <div className="overflow-hidden rounded-xl border border-[#1e293b]">
                  <div className="border-b border-[#1e293b] px-4 py-3 text-sm font-semibold text-slate-200">Reported telemetry fields</div>
                  <div className="max-h-72 overflow-auto">
                    {rawRows.map((row) => <div key={row.path} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b border-[#1e293b]/70 px-4 py-2 text-xs"><span className="truncate font-mono text-blue-400">{row.path}</span><span className="truncate font-mono text-slate-300">{row.value}</span></div>)}
                  </div>
                </div>
              ) : tab === 'Alarms' ? <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-5 text-sm text-emerald-400">No active alarms are reported for this inverter.</div> : (
                <div className="rounded-xl border border-[#1e293b] bg-[#0f1423] p-5 text-sm text-slate-300">
                  {tab === 'Data Quality' ? 'Latest values are shown exactly as received from the current telemetry source. Raw register detail is available in the Raw Data tab.' : `Latest ${tab.toLowerCase()} monitoring is shown above. Values update when this inverter reports fresh telemetry.`}
                </div>
              )}
            </div>
          ) : (
            <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center">
              <Activity size={32} className="mb-4 text-slate-500" />
              <h3 className="text-lg font-semibold text-slate-100">No {tab.toLowerCase()} telemetry reported</h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">{device.name} has not sent values for this section yet. The dashboard will show them automatically when the corresponding MQTT parameters arrive.</p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function AppShell() {
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [mode, setMode] = useState<'demo' | 'live'>(() => (localStorage.getItem('northline-mode') as 'demo' | 'live') || 'live');
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem('solar-scada-theme') as ThemeMode) || 'dark');
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => localStorage.getItem('solar-scada-navigation-collapsed') === 'true');
  const [activeSection, setActiveSection] = useState('overview');
  const [selectedInverterId, setSelectedInverterId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [rawPayload, setRawPayload] = useState('Waiting for the first MQTT payload…');
  const [rawJson, setRawJson] = useState<JsonValue | null>(null);
  const [modbusRows, setModbusRows] = useState<ModbusRow[]>([]);
  const [persistence, setPersistence] = useState<PersistenceStatus>({ intervalMinutes: 10, pendingMessages: 0 });
  const [appliedTimeFilter, setAppliedTimeFilter] = useState<AppliedTimeFilter>(() => appliedTimeFilterFromDraft(timeFilterDraftForPreset('live', DEFAULT_SITE_TIMEZONE), DEFAULT_SITE_TIMEZONE)!);
  const [timeFilterRefreshToken, setTimeFilterRefreshToken] = useState(0);
  const [rawTopic, setRawTopic] = useState(DEFAULT_BROKER_TOPIC);
  const [activeSite, setActiveSite] = useState(() => initialDevices.find((device) => device.type.toLowerCase().includes('weather'))?.site ?? initialDevices[0]?.site ?? 'Plant site');
  const [weatherState, setWeatherState] = useState<WeatherState>({ status: 'unavailable', message: 'No configured coordinates are available for the selected plant/site.' });
  const [weatherRefreshToken, setWeatherRefreshToken] = useState(0);
  const streamRef = useRef<EventSource | null>(null);
  const plantTimezone = persistence.timezone || DEFAULT_SITE_TIMEZONE;

  useEffect(() => { localStorage.setItem('northline-mode', mode); }, [mode]);
  useEffect(() => {
    localStorage.setItem('solar-scada-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  useEffect(() => { localStorage.setItem('solar-scada-navigation-collapsed', String(navigationCollapsed)); }, [navigationCollapsed]);
  useEffect(() => {
    setAppliedTimeFilter((current) => current.preset === 'live' ? { ...current, timezone: plantTimezone } : current);
  }, [plantTimezone]);
  useEffect(() => {
    if (!mobileNav) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNav(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileNav]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10000); return () => window.clearInterval(timer); }, []);
  const availableSites = useMemo(() => Array.from(new Set(devices.map((device) => device.site).filter(Boolean))).sort(), [devices]);
  useEffect(() => {
    if (availableSites.length && !availableSites.includes(activeSite)) setActiveSite(availableSites[0]);
  }, [activeSite, availableSites]);
  const plantSiteName = activeSite;
  const configuredSiteLocation = useMemo(() => findConfiguredSiteLocation(devices, plantSiteName), [devices, plantSiteName]);
  const weatherLocation = configuredSiteLocation;

  useEffect(() => {
    if (!weatherLocation) return;
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
  }, [weatherLocation?.latitude, weatherLocation?.longitude, weatherRefreshToken]);

  // Demo Stream Generator
  useEffect(() => {
    if (!connected || mode !== 'demo') return;
    const timer = window.setInterval(() => {
      setDevices((current) => current.map((device) => {
        if (device.status === 'offline') return device;
        const currentKw = numberFrom(device, ['power', 'active_kw']);
        const nextKw = device.id.startsWith('met') ? currentKw : Math.max(0, currentKw + (Math.random() - .48) * 5.5);
        const telemetry = { ...device.telemetry, power: { ...(typeof device.telemetry.power === 'object' && device.telemetry.power !== null && !Array.isArray(device.telemetry.power) ? device.telemetry.power : {}), active_kw: Number(nextKw.toFixed(1)) } };
        return { ...device, lastSeen: Date.now(), telemetry, status: 'online' };
      }));
      setNow(Date.now());
      
      // Also push some mock Modbus rows for demo
      if (Math.random() > 0.5) {
        setModbusRows(prev => {
           const mockRow: ModbusRow = {
             name: 'Phase A Voltage', addr: '40001', full_addr: '40001', data: 770 + Math.random() * 5, raw_data: 7700 + Math.floor(Math.random() * 50),
             server_name: 'Inverter Demo', timestamp: Date.now()
           };
           const key = modbusRowKey(mockRow);
           const next = [...prev.filter(r => modbusRowKey(r) !== key), mockRow];
           return next.slice(-50); // keep recent 50
        });
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [connected, mode]);

  const changeMode = (next: 'demo' | 'live') => {
    setMode(next);
    setError('');
    setConnected(next === 'demo');
    if (next === 'demo') {
      const demoPayload = initialDevices[0].telemetry;
      setRawPayload(JSON.stringify(demoPayload, null, 2));
      setRawJson(demoPayload);
      setRawTopic('northline/site/north-array/telemetry');
    }
  };

  const ingestPayload = (raw: string, topic: string) => {
    setRawPayload(raw);
    setRawTopic(topic);
    try {
      const payload = JSON.parse(raw) as JsonValue;
      setRawJson(payload);
      const incomingRows = extractModbusRows(payload);
      if (incomingRows.length) {
        setModbusRows((current) => {
          const next = [...current];
          for (const incoming of incomingRows) {
            const existingIndex = next.findIndex((row) => modbusRowKey(row) === modbusRowKey(incoming));
            if (existingIndex >= 0) next[existingIndex] = incoming;
            else next.push(incoming);
          }
          return next;
        });
      }
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
          lastSeen: Date.now(),
          telemetry,
        };
        return existing ? next.map((item) => item.id === identity ? { ...item, ...device } : item) : [device, ...next];
      }, current));
      setError('');
    } catch {
      setRawJson(null);
      setError('A broker message arrived, but its payload was not valid JSON. The raw payload is still shown below.');
    }
  };

  const connect = (_url?: string, requestedTopic?: string) => {
    setError('');
    if (mode === 'demo') {
      setConnected(true);
      setSettingsOpen(false);
      return;
    }
    if (requestedTopic) setRawTopic(requestedTopic);
    streamRef.current?.close();
    const stream = new EventSource('/api/mqtt/stream');
    streamRef.current = stream;
    stream.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as { connected: boolean; error?: string; persistence?: PersistenceStatus };
      setConnected(status.connected);
      if (status.persistence) setPersistence(status.persistence);
      if (status.connected) setError('');
      else if (status.error === 'connack timeout') setError('The MQTT broker is not responding to the connection handshake. The dashboard will retry automatically.');
      else setError('MQTT broker is reconnecting. Raw data will appear as soon as the subscription is restored.');
    });
    stream.addEventListener('message', (event) => {
      const message = JSON.parse((event as MessageEvent).data) as { topic: string; payload: string };
      ingestPayload(message.payload, message.topic);
      setConnected(true);
    });
    stream.onerror = () => setConnected(false);
    setSettingsOpen(false);
  };

  useEffect(() => {
    if (mode !== 'live') return;
    connect();
    return () => {
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [mode]);

  const disconnect = () => {
    streamRef.current?.close();
    streamRef.current = null;
    setConnected(false);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
  };
  const navigateTo = (section: string) => {
    setActiveSection(section);
    window.requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const refreshTelemetry = () => {
    if (mode === 'live') connect();
    else setNow(Date.now());
  };
  const refreshTimeFilter = () => {
    setTimeFilterRefreshToken((token) => token + 1);
    if (appliedTimeFilter.preset === 'live') refreshTelemetry();
  };
  const refreshWeather = () => {
    if (weatherLocation) setWeatherRefreshToken((token) => token + 1);
    else setWeatherState({ status: 'unavailable', message: 'Weather data unavailable for this site: configure plant/site or registered device coordinates in SCADA telemetry.' });
  };
  const changeActiveSite = (site: string) => {
    setActiveSite(site);
    setWeatherState({ status: 'unavailable', message: 'Weather data unavailable for this site: waiting for configured plant/site or registered device coordinates.' });
  };
  const exportTelemetry = () => {
    const columns = ['parameter', 'raw_value', 'customer_value', 'unit', 'modbus_address', 'source', 'timestamp'];
    const escapeCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const lines = modbusRows.map((row) => {
      const name = String(row.name || '');
      const lowerName = name.toLowerCase();
      const unit = lowerName.includes('voltage') ? 'V' : lowerName.includes('current') ? 'A' : lowerName.includes('frequency') ? 'Hz' : lowerName.includes('power') ? 'kW' : lowerName.includes('temp') ? '°C' : '';
      return [name, row.raw_data ?? row.data, row.data, unit, row.full_addr ?? row.addr, row.server_name ?? 'Modbus', row.date_iso_8601 ?? row.timestamp ?? row.date].map(escapeCell).join(',');
    });
    const metadata = ['SCADA time scope', timeFilterLabel(appliedTimeFilter), `Timezone: ${appliedTimeFilter.timezone}`, 'Current-only export: yes'].map(escapeCell).join(',');
    const blob = new Blob([[metadata, columns.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trn246-live-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const totalAcPower = useMemo(() => devices.filter(d => d.status === 'online').reduce((sum, d) => sum + numberFrom(d, ['power', 'active_kw'], 0), 0), [devices]);
  const inverters = useMemo(() => devices.filter(d => d.type === 'Power inverter'), [devices]);
  const selectedInverter = useMemo(() => selectedInverterId ? devices.find((device) => device.id === selectedInverterId) ?? null : null, [devices, selectedInverterId]);
  const onlineInverters = inverters.filter(d => d.status === 'online').length;
  const totalInverters = inverters.length;
  const activeAlarms = useMemo(() => devices.reduce((sum, d) => sum + (Array.isArray(d.telemetry.alarms) ? d.telemetry.alarms.length : 0), 0), [devices]);

  return (
    <div className={`scada-theme ${theme === 'dark' ? 'dark' : 'light'} flex h-screen overflow-hidden bg-[#0b0f19] font-sans text-slate-200`}>
      {mobileNav && <button type="button" aria-label="Close navigation" data-testid="button-navigation-overlay" onClick={() => setMobileNav(false)} className="fixed inset-0 z-20 bg-black/40 backdrop-blur-[1px] md:hidden" />}
      <Sidebar onSettings={() => setSettingsOpen(true)} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} activeSection={activeSection} onNavigate={navigateTo} collapsed={navigationCollapsed} onToggleCollapse={() => setNavigationCollapsed((current) => !current)} />
      
      <div className="flex flex-col flex-1 min-w-0">
        <Header toggleMobileNav={() => setMobileNav(true)} mobileNav={mobileNav} connected={connected} mode={mode} theme={theme} onToggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} onRefresh={refreshTelemetry} onExport={exportTelemetry} onNotifications={() => navigateTo('alarms')} now={now} weather={weatherState} siteName={plantSiteName} />
        
        <main className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto space-y-6 p-3 scrollbar-thin sm:p-6">
          <section id="overview" data-section="overview" className="scroll-mt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div title="Current line frequency from the latest telemetry source.">
                <p className="text-xs font-medium text-slate-500">Dashboard <span className="px-1 text-slate-400">/</span> <span className="text-slate-300">{activeSection === 'overview' ? 'Plant Overview' : activeSection.replace(/-/g, ' ')}</span></p>
                <h1 className="mt-1 text-lg font-bold text-slate-100">Plant operations at a glance</h1>
              </div>
              <div role="status" data-testid="status-telemetry-connection" className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${connected ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-400' : 'border-amber-500/25 bg-amber-500/5 text-amber-400'}`}>
                <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 pulse-soft' : 'bg-amber-400'}`} />
                {connected ? `Receiving ${mode === 'live' ? 'live' : 'demo'} telemetry` : 'Waiting for telemetry connection'}
                {!connected && <button type="button" onClick={refreshTelemetry} data-testid="button-retry-connection" className="ml-1 underline underline-offset-2 focus-ring">Retry</button>}
              </div>
            </div>
            {error && <div role="alert" data-testid="alert-telemetry-error" className="mb-4 flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/5 p-4 text-sm text-rose-400"><AlertCircle size={18} className="mt-0.5 shrink-0" /><div><strong className="font-semibold">Telemetry needs attention.</strong><p className="mt-1 text-rose-300">{error}</p></div><button type="button" onClick={refreshTelemetry} className="ml-auto whitespace-nowrap text-xs font-semibold underline focus-ring">Retry connection</button></div>}
            {appliedTimeFilter.preset !== 'live' && <div role="status" data-testid="status-dashboard-current-only" className="mb-4 rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-[10px] leading-4 text-violet-200">Historical window applied: {timeFilterLabel(appliedTimeFilter)}. Dashboard KPI cards, data quality, alarms, inverter status, weather, and raw payload remain current-only; Electrical Parameters is the range-backed historical view.</div>}
            <TimeFilterPanel applied={appliedTimeFilter} timezone={plantTimezone} onApply={setAppliedTimeFilter} onReset={() => setAppliedTimeFilter(appliedTimeFilterFromDraft(timeFilterDraftForPreset('live', plantTimezone), plantTimezone)!)} onRefresh={refreshTimeFilter} refreshing={appliedTimeFilter.preset !== 'live' && false} />
            <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
              <KpiCard title="Total AC Power" value={totalAcPower.toLocaleString(undefined, { maximumFractionDigits: 2 })} unit="kW" icon={Zap} colorClass="bg-blue-500/10 text-blue-400" onClick={() => navigateTo('power')} help="Open the realtime plant power trend and choose a time range." />
              <KpiCard title="Today's Energy" value="14.13" unit="MWh" icon={Sun} colorClass="bg-orange-500/10 text-orange-400" subtext="Daily energy" onClick={() => navigateTo('energy')} help="Open energy analytics for daily, monthly, or yearly production." />
              <KpiCard title="Total Energy" value="31,457.28" unit="kWh" icon={Database} colorClass="bg-purple-500/10 text-purple-400" subtext="Lifetime energy" onClick={() => navigateTo('energy')} help="Open energy analytics and historical production views." />
              <KpiCard title="Specific Yield" value="4.62" unit="kWh/kWp" icon={Activity} colorClass="bg-pink-500/10 text-pink-400" subtext="PR 87.3%" onClick={() => navigateTo('power')} help="Open performance metrics and realtime power monitoring." />
              <KpiCard title="Inverters Online" value={`${onlineInverters}/${totalInverters}`} icon={Check} colorClass="bg-emerald-500/10 text-emerald-400" subtext="100% online" onClick={() => navigateTo('inverters')} help="Open the inverter fleet and select an inverter for details." />
              <KpiCard title="Active Alarms" value={activeAlarms.toString()} icon={AlertTriangle} colorClass="bg-emerald-500/10 text-emerald-400" subtext="All clear" onClick={() => navigateTo('alarms')} help="Open the alarm and fault status for the plant." />
            </div>
          </section>
          
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div id="electrical" data-section="electrical" className="min-w-0 scroll-mt-6 xl:col-span-2">
                <ElectricalParametersChart rows={modbusRows} mode={mode} timeFilter={appliedTimeFilter} refreshToken={timeFilterRefreshToken} />
            </div>
            <div id="inverters" data-section="inverters" className="min-w-0 scroll-mt-6">
               <InverterOverviewTable devices={devices} onOpenInverter={(device) => setSelectedInverterId(device.id)} onViewAll={() => navigateTo('inverters')} timeFilter={appliedTimeFilter} />
            </div>
          </div>
          
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 xl:grid-cols-5">
              <div id="energy" data-section="energy" className="min-w-0 scroll-mt-6 xl:col-span-1">
                <EnergySummaryChart timeFilter={appliedTimeFilter} />
             </div>
              <div id="power" data-section="power" className="min-w-0 scroll-mt-6 xl:col-span-2">
                <PowerTrendChart currentKw={totalAcPower} timeFilter={appliedTimeFilter} />
             </div>
             <div className="min-w-0 xl:col-span-1">
                <PowerDistributionChart timeFilter={appliedTimeFilter} />
             </div>
              <div id="alarms" data-section="alarms" className="min-w-0 scroll-mt-6 xl:col-span-1">
                 <SidePanels timeFilter={appliedTimeFilter} />
             </div>
          </div>

          <EnvironmentDetails siteName={plantSiteName} sites={availableSites} weather={weatherState} onRefresh={refreshWeather} onSiteChange={changeActiveSite} />

           <DetailedLiveDataTable rows={modbusRows} persistence={persistence} timeFilter={appliedTimeFilter} />

           <CompletePayloadInspector rawPayload={rawPayload} rawJson={rawJson} topic={rawTopic} onCopy={handleCopy} timeFilter={appliedTimeFilter} />
          
        </main>
      </div>
       <BrokerPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} mode={mode} setMode={changeMode} connected={connected} onConnect={connect} onDisconnect={disconnect} error={error} />
        {selectedInverter && <InverterDetailPanel device={selectedInverter} onClose={() => setSelectedInverterId(null)} />}
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
