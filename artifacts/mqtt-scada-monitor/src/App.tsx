import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity, AlertCircle, AlertTriangle, ArrowDownToLine, Check, ChevronDown, ChevronRight,
  CircleHelp, CloudOff, Code2, Copy, Database, Gauge, HardDrive, Layers3, LayoutDashboard,
  Link2, Menu, MoreHorizontal, Pause, Play, PlugZap, Radio, RefreshCw, Search, Settings2,
  ShieldCheck, SlidersHorizontal, Thermometer, Wifi, WifiOff, X, Zap,
} from 'lucide-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

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

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    id: 'inv-03', name: 'Inverter 03', site: 'North Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 1800,
    telemetry: { power: { active_kw: 186.4, reactive_kvar: -4.2, efficiency: 97.8 }, dc_bus: { voltage_v: 812.6, current_a: 229.1 }, temperature: { cabinet_c: 39.8, heatsink_c: 44.1 }, alarms: [], firmware: 'v3.14.8' },
  },
  {
    id: 'inv-07', name: 'Inverter 07', site: 'West Array', type: 'Power inverter', status: 'online', lastSeen: Date.now() - 4100,
    telemetry: { power: { active_kw: 172.8, reactive_kvar: 1.7, efficiency: 96.9 }, dc_bus: { voltage_v: 808.2, current_a: 214.8 }, temperature: { cabinet_c: 42.1, heatsink_c: 48.5 }, alarms: [], firmware: 'v3.14.8' },
  },
  {
    id: 'inv-02', name: 'Inverter 02', site: 'North Array', type: 'Power inverter', status: 'stale', lastSeen: Date.now() - 462000,
    telemetry: { power: { active_kw: 0, reactive_kvar: 0, efficiency: 0 }, dc_bus: { voltage_v: 760.8, current_a: 0 }, temperature: { cabinet_c: 35.2, heatsink_c: 36.4 }, alarms: ['telemetry_timeout'], firmware: 'v3.13.9' },
  },
  {
    id: 'met-01', name: 'Met Station 01', site: 'North Array', type: 'Weather sensor', status: 'online', lastSeen: Date.now() - 9200,
    telemetry: { irradiance: { ghi_w_m2: 742.8, dni_w_m2: 801.2 }, ambient: { temperature_c: 24.6, humidity_pct: 41.8, wind_speed_ms: 3.7 }, panel: { temperature_c: 37.9 }, sample: { interval_s: 10, quality: 'good' } },
  },
  {
    id: 'inv-11', name: 'Inverter 11', site: 'East Array', type: 'Power inverter', status: 'offline', lastSeen: Date.now() - 3880000,
    telemetry: { power: { active_kw: 0, reactive_kvar: 0, efficiency: 0 }, dc_bus: { voltage_v: 0, current_a: 0 }, temperature: { cabinet_c: 23.2, heatsink_c: 23.8 }, alarms: ['connection_lost', 'dc_undervoltage'], firmware: 'v3.14.6' },
  },
];

const statusMeta: Record<DeviceStatus, { label: string; color: string; dot: string }> = {
  online: { label: 'Online', color: 'text-teal-700 bg-teal-50 border-teal-200', dot: 'bg-teal-500' },
  stale: { label: 'Stale', color: 'text-amber-800 bg-amber-50 border-amber-200', dot: 'bg-amber-500' },
  offline: { label: 'Offline', color: 'text-rose-700 bg-rose-50 border-rose-200', dot: 'bg-rose-500' },
};

function formatLastSeen(timestamp: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

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
  return typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(value);
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

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'teal' | 'amber' | 'rose' }) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-600 border-slate-200',
    teal: 'bg-teal-50 text-teal-700 border-teal-200',
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[.11em] ${tones[tone]}`}>{children}</span>;
}

function StatusDot({ status }: { status: DeviceStatus }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${statusMeta[status].dot} ${status === 'online' ? 'pulse-soft' : ''}`} />;
}

function Sparkline({ points, danger = false }: { points: number[]; danger?: boolean }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = points.map((point, index) => `${(index / (points.length - 1)) * 100},${34 - ((point - min) / range) * 25}`).join(' ');
  return (
    <svg viewBox="0 0 100 38" preserveAspectRatio="none" className="h-10 w-full overflow-visible" aria-hidden="true">
      <path d={`M ${path}`} fill="none" stroke={danger ? '#d26251' : '#0d8f80'} strokeWidth="1.8" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MetricCard({ icon: Icon, label, value, detail, points, tone = 'teal' }: { icon: typeof Activity; label: string; value: string; detail: string; points: number[]; tone?: 'teal' | 'amber' | 'rose' }) {
  const color = tone === 'amber' ? 'text-amber-700 bg-amber-50' : tone === 'rose' ? 'text-rose-700 bg-rose-50' : 'text-teal-700 bg-teal-50';
  return (
    <article className="group relative overflow-hidden rounded-xl border border-[#d8e5df] bg-white p-4 shadow-[0_3px_14px_rgba(24,42,43,.035)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_9px_24px_rgba(24,42,43,.08)]">
      <div className="flex items-start justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}><Icon size={16} strokeWidth={2.2} /></div>
        <span className="mono text-[10px] text-slate-400">24 H</span>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div><p className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-500">{label}</p><p className="mt-1 text-[25px] font-extrabold tracking-[-.04em] text-[#263c40]">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div>
        <div className="mb-1 w-[39%] opacity-80"><Sparkline points={points} danger={tone === 'rose'} /></div>
      </div>
    </article>
  );
}

function DeviceRow({ device, selected, onSelect }: { device: Device; selected: boolean; onSelect: () => void }) {
  const status = statusMeta[device.status];
  return (
    <button type="button" onClick={onSelect} data-testid={`button-select-device-${device.id}`} className={`focus-ring group w-full border-b border-[#e7efeb] px-4 py-3 text-left transition-colors last:border-0 ${selected ? 'bg-[#e9f5f1]' : 'hover:bg-[#f5f9f7]'}`}>
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-[#c9e8de] text-[#08796d]' : 'bg-slate-100 text-slate-500'}`}><Zap size={17} strokeWidth={2.2} /></div>
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-sm font-bold text-[#2c4144]">{device.name}</span>{device.status === 'stale' && <AlertTriangle size={13} className="shrink-0 text-amber-600" />}</div><p className="mt-0.5 truncate text-[11px] text-slate-500">{device.site} · {device.type}</p></div>
        <div className="text-right"><div className="flex items-center justify-end gap-1.5"><StatusDot status={device.status} /><span className={`text-[10px] font-bold uppercase tracking-wider ${status.color.split(' ')[0]}`}>{status.label}</span></div><p className="mono mt-1 text-[10px] text-slate-400">{formatLastSeen(device.lastSeen)}</p></div>
      </div>
    </button>
  );
}

function FieldTree({ value, path = [], onCopy }: { value: JsonValue; path?: string[]; onCopy: (text: string) => void }) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return <div className="flex min-w-0 items-center justify-end gap-2"><span className="mono truncate text-xs font-medium text-[#3a5457]">{formatValue(value)}</span><button type="button" onClick={() => onCopy(formatValue(value))} data-testid={`button-copy-field-${path.join('-')}`} className="focus-ring rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-teal-700 group-hover:opacity-100"><Copy size={12} /></button></div>;
  }
  return (
    <div className="space-y-0.5">
      {Object.entries(value).map(([key, child]) => {
        const childPath = [...path, key];
        const nested = typeof child === 'object' && child !== null && !Array.isArray(child);
        return (
          <div key={childPath.join('.')} className="group">
            <div className="flex min-h-8 items-center justify-between gap-4 rounded-md px-2.5 transition-colors hover:bg-[#f1f7f4]">
              <div className="flex min-w-0 items-center gap-2"><span className="text-[12px] text-slate-500">{nested ? <ChevronRight size={13} className="text-slate-400" /> : <span className="ml-1.5 inline-block h-1 w-1 rounded-full bg-teal-500" />}</span><span className="truncate font-mono text-[12px] font-medium text-[#426064]">{key}</span></div>
              <div className="min-w-0">{nested ? <span className="mono text-[10px] text-slate-400">{Object.keys(child).length} fields</span> : <FieldTree value={child} path={childPath} onCopy={onCopy} />}</div>
            </div>
            {nested && <div className="ml-5 border-l border-[#dce9e3] pl-2"><FieldTree value={child} path={childPath} onCopy={onCopy} /></div>}
          </div>
        );
      })}
    </div>
  );
}

function Sidebar({ onSettings, mobileOpen, onClose, brokerUrl, brokerTopic, live }: { onSettings: () => void; mobileOpen: boolean; onClose: () => void; brokerUrl: string; brokerTopic: string; live: boolean }) {
  return (
    <aside className={`fixed inset-y-0 left-0 z-30 flex w-[246px] flex-col border-r border-[#314850] bg-[#20343d] text-slate-100 transition-transform duration-300 md:static md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex h-[76px] items-center justify-between border-b border-[#314850] px-5">
        <div className="flex items-center gap-3"><div className="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#f2bd59] text-[#20343d]"><Activity size={20} strokeWidth={2.7} /><span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#58d2b8] ring-2 ring-[#20343d]" /></div><div><p className="text-sm font-extrabold tracking-[-.02em]">Northline</p><p className="mono mt-0.5 text-[9px] uppercase tracking-[.16em] text-slate-400">SCADA / OPS</p></div></div>
        <button type="button" onClick={onClose} data-testid="button-close-sidebar" className="focus-ring rounded-md p-1 text-slate-400 hover:bg-[#2c4751] hover:text-white md:hidden"><X size={18} /></button>
      </div>
      <div className="flex-1 px-3 py-5">
        <p className="px-3 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Workspace</p>
        <nav className="mt-3 space-y-1">
          <button type="button" data-testid="button-nav-overview" className="flex w-full items-center gap-3 rounded-lg bg-[#2d4a53] px-3 py-2.5 text-left text-sm font-bold text-white shadow-inner shadow-white/5"><LayoutDashboard size={17} className="text-[#70ddc3]" />Overview<span className="ml-auto rounded bg-[#397169] px-1.5 py-0.5 mono text-[10px] text-[#a6f0dc]">LIVE</span></button>
          <button type="button" data-testid="button-nav-topology" onClick={() => window.alert('Topology view is available when additional site maps are connected.')} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-400 transition-colors hover:bg-[#2a444d] hover:text-slate-100"><Layers3 size={17} />Topology</button>
          <button type="button" data-testid="button-nav-events" onClick={() => window.alert('All events are shown in the alert feed on this overview.')} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-400 transition-colors hover:bg-[#2a444d] hover:text-slate-100"><AlertCircle size={17} />Event log<span className="ml-auto rounded-full bg-[#754945] px-1.5 py-0.5 mono text-[10px] text-[#ffc0a7]">3</span></button>
        </nav>
        <p className="mt-9 px-3 text-[10px] font-bold uppercase tracking-[.18em] text-slate-500">Connection</p>
        <div className="mt-3 rounded-xl border border-[#39545b] bg-[#263f48] p-3">
           <div className="flex items-center gap-2"><span className="relative flex h-7 w-7 items-center justify-center rounded-md bg-[#d8a94f]/20 text-[#f3c96d]"><Radio size={15} /><span className="absolute inset-0 animate-ping rounded-md bg-[#f3c96d]/10" /></span><div><p className="text-xs font-bold text-slate-100">{live ? 'MQTT broker' : 'Demo channel'}</p><p className="mono mt-0.5 max-w-[155px] truncate text-[9px] text-slate-400">{live ? brokerTopic : 'northline/site/+/telemetry'}</p></div></div>
           <div className="mt-3 flex items-center gap-2 border-t border-[#39545b] pt-3 text-[10px] text-[#8ee4cf]"><span className="h-1.5 w-1.5 rounded-full bg-[#63d9be]" />{live ? `Listening on ${brokerUrl}` : 'Receiving local sample data'}</div>
        </div>
      </div>
      <div className="border-t border-[#314850] p-3">
        <button type="button" onClick={onSettings} data-testid="button-open-settings" className="focus-ring flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-400 transition-colors hover:bg-[#2a444d] hover:text-white"><Settings2 size={17} />Broker settings<ChevronRight size={14} className="ml-auto" /></button>
        <div className="mt-4 flex items-center gap-2 px-3"><div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#39626a] text-[10px] font-extrabold text-[#bcefe1]">OP</div><div><p className="text-xs font-bold text-slate-200">Operator console</p><p className="mono text-[9px] text-slate-500">shift A · read / inspect</p></div><MoreHorizontal size={16} className="ml-auto text-slate-500" /></div>
      </div>
    </aside>
  );
}

function BrokerPanel({ open, onClose, mode, setMode, connected, onConnect, onDisconnect, error }: { open: boolean; onClose: () => void; mode: 'demo' | 'live'; setMode: (mode: 'demo' | 'live') => void; connected: boolean; onConnect: (url: string, topic: string) => void; onDisconnect: () => void; error: string }) {
  const [url, setUrl] = useState(() => localStorage.getItem('northline-broker-url') || DEFAULT_BROKER_URL);
  const [topic, setTopic] = useState(() => localStorage.getItem('northline-broker-topic') || DEFAULT_BROKER_TOPIC);
  const handleConnect = () => { localStorage.setItem('northline-broker-url', url); localStorage.setItem('northline-broker-topic', topic); onConnect(url, topic); };
  return (
    <>
      {open && <button type="button" aria-label="Close broker settings" data-testid="button-close-settings-overlay" onClick={onClose} className="fixed inset-0 z-20 cursor-default bg-[#183038]/25 backdrop-blur-[2px]" />}
      <section className={`fixed right-0 top-0 z-40 flex h-full w-full max-w-[410px] flex-col border-l border-[#d8e5df] bg-[#fbfdfc] shadow-[-18px_0_50px_rgba(24,42,43,.14)] transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-start justify-between border-b border-[#dfeae5] px-6 py-5"><div><p className="mono text-[10px] font-medium uppercase tracking-[.15em] text-teal-700">Transport control</p><h2 className="mt-1 text-xl font-extrabold tracking-[-.04em] text-[#273d40]">Broker connection</h2><p className="mt-1 text-xs text-slate-500">Persisted locally on this operator station.</p></div><button type="button" onClick={onClose} data-testid="button-close-settings" className="focus-ring rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={19} /></button></div>
        <div className="flex-1 overflow-y-auto px-6 py-6 scrollbar-thin">
          <div className="rounded-xl border border-[#d8e5df] bg-white p-1"><div className="grid grid-cols-2 gap-1"><button type="button" onClick={() => setMode('demo')} data-testid="button-mode-demo" className={`rounded-lg px-3 py-2.5 text-xs font-bold transition-colors ${mode === 'demo' ? 'bg-[#e5f3ee] text-teal-800' : 'text-slate-500 hover:bg-slate-50'}`}><div className="flex items-center justify-center gap-2"><Play size={14} />Demo mode</div></button><button type="button" onClick={() => setMode('live')} data-testid="button-mode-live" className={`rounded-lg px-3 py-2.5 text-xs font-bold transition-colors ${mode === 'live' ? 'bg-[#e5f3ee] text-teal-800' : 'text-slate-500 hover:bg-slate-50'}`}><div className="flex items-center justify-center gap-2"><Wifi size={14} />Live broker</div></button></div></div>
          <div className="mt-7 space-y-5">
            <label className="block"><span className="mb-2 block text-xs font-bold text-[#354e51]">Broker endpoint</span><div className="relative"><Link2 size={15} className="absolute left-3 top-3.5 text-slate-400" /><input value={url} readOnly data-testid="input-broker-url" className="mono w-full cursor-default rounded-lg border border-[#d2e0db] bg-slate-50 py-3 pl-9 pr-3 text-xs text-[#30494c] outline-none" /></div><span className="mt-1.5 block text-[11px] leading-4 text-slate-400">Server-side MQTT connection. Credentials are held securely outside this screen.</span></label>
            <label className="block"><span className="mb-2 block text-xs font-bold text-[#354e51]">Subscription topic</span><div className="relative"><Radio size={15} className="absolute left-3 top-3.5 text-slate-400" /><input value={topic} readOnly data-testid="input-broker-topic" className="mono w-full cursor-default rounded-lg border border-[#d2e0db] bg-slate-50 py-3 pl-9 pr-3 text-xs text-[#30494c] outline-none" /></div><span className="mt-1.5 block text-[11px] leading-4 text-slate-400">Any JSON payload is accepted; fields are discovered automatically.</span></label>
          </div>
          {error && <div className="mt-6 flex gap-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-800"><AlertCircle size={16} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
          <div className="mt-8 rounded-xl border border-[#d8e5df] bg-[#f3f8f5] p-4"><div className="flex items-center gap-2 text-xs font-bold text-[#355557]"><ShieldCheck size={16} className="text-teal-700" />Connection checklist</div><ul className="mt-3 space-y-2 text-[11px] leading-4 text-slate-500"><li className="flex gap-2"><Check size={13} className="shrink-0 text-teal-600" />JSON payloads parsed without a field map</li><li className="flex gap-2"><Check size={13} className="shrink-0 text-teal-600" />Device identity inferred from id, device, or name</li><li className="flex gap-2"><Check size={13} className="shrink-0 text-teal-600" />Last-seen clock tracks every message</li></ul></div>
        </div>
        <div className="border-t border-[#dfeae5] bg-white px-6 py-5">{connected ? <button type="button" onClick={onDisconnect} data-testid="button-disconnect-broker" className="focus-ring flex w-full items-center justify-center gap-2 rounded-lg border border-rose-200 bg-rose-50 py-3 text-sm font-bold text-rose-700 transition-colors hover:bg-rose-100"><WifiOff size={16} />Disconnect broker</button> : <button type="button" onClick={handleConnect} data-testid="button-connect-broker" className="focus-ring flex w-full items-center justify-center gap-2 rounded-lg bg-[#197f72] py-3 text-sm font-bold text-white shadow-[0_4px_12px_rgba(25,127,114,.22)] transition-all hover:bg-[#126b61] active:scale-[.99]"><PlugZap size={16} />{mode === 'demo' ? 'Start demo stream' : 'Connect to broker'}</button>}</div>
      </section>
    </>
  );
}

function AppShell() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedId, setSelectedId] = useState('inv-03');
  const [mode, setMode] = useState<'demo' | 'live'>('live');
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | DeviceStatus>('all');
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [rawPayload, setRawPayload] = useState('Waiting for the first MQTT payload…');
  const [rawTopic, setRawTopic] = useState(DEFAULT_BROKER_TOPIC);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => { localStorage.setItem('northline-mode', mode); }, [mode]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!connected || mode !== 'demo' || paused) return;
    const timer = window.setInterval(() => {
      setDevices((current) => current.map((device) => {
        if (device.status === 'offline') return device;
        const currentKw = numberFrom(device, ['power', 'active_kw']);
        const nextKw = device.id.startsWith('met') ? currentKw : Math.max(0, currentKw + (Math.random() - .48) * 5.5);
        const telemetry = { ...device.telemetry, power: { ...(typeof device.telemetry.power === 'object' && device.telemetry.power !== null && !Array.isArray(device.telemetry.power) ? device.telemetry.power : {}), active_kw: Number(nextKw.toFixed(1)) } };
        return { ...device, lastSeen: Date.now(), telemetry, status: 'online' };
      }));
      setNow(Date.now());
    }, 3000);
    return () => window.clearInterval(timer);
  }, [connected, mode, paused]);

  const selected = devices.find((device) => device.id === selectedId) || devices[0];
  const filteredDevices = useMemo(() => devices.filter((device) => (filter === 'all' || device.status === filter) && `${device.name} ${device.site} ${device.type}`.toLowerCase().includes(query.toLowerCase())), [devices, filter, query]);
  const online = devices.filter((device) => device.status === 'online').length;
  const alerts = devices.filter((device) => device.status !== 'online').length;
  const totalPower = devices.reduce((sum, device) => sum + numberFrom(device, ['power', 'active_kw']), 0);
  const selectDevice = (id: string) => { setSelectedId(id); setMobileNav(false); };
  const changeMode = (next: 'demo' | 'live') => {
    setMode(next);
    setError('');
    setConnected(next === 'demo');
    if (next === 'demo' && !devices.length) {
      setDevices(initialDevices);
      setSelectedId(initialDevices[0].id);
      setRawPayload(JSON.stringify(initialDevices[0].telemetry, null, 2));
      setRawTopic('northline/site/north-array/telemetry');
    }
  };
  const ingestPayload = (raw: string, topic: string) => {
    setRawPayload(raw);
    setRawTopic(topic);
    try {
      const payload = JSON.parse(raw) as JsonValue;
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
      setError('A broker message arrived, but its payload was not valid JSON. The raw payload is still shown below.');
    }
  };
  const connect = () => {
    setError('');
    if (mode === 'demo') { setConnected(true); setSettingsOpen(false); return; }
    streamRef.current?.close();
    const stream = new EventSource('/api/mqtt/stream');
    streamRef.current = stream;
    stream.addEventListener('status', (event) => {
      const status = JSON.parse((event as MessageEvent).data) as { connected: boolean };
      setConnected(status.connected);
      if (!status.connected) setError('MQTT broker is reconnecting. Raw data will appear as soon as the subscription is restored.');
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
  const copyField = (text: string) => { void navigator.clipboard?.writeText(text); };
  const exportSnapshot = () => {
    const file = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), devices }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = 'northline-telemetry.json'; link.click(); URL.revokeObjectURL(link.href);
  };

  return (
    <div className="flex min-h-[100dvh] bg-[#eef4f0]">
       <Sidebar onSettings={() => setSettingsOpen(true)} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} brokerUrl={DEFAULT_BROKER_URL} brokerTopic={rawTopic} live={mode === 'live'} />
      {mobileNav && <button type="button" aria-label="Close navigation" data-testid="button-close-navigation-overlay" onClick={() => setMobileNav(false)} className="fixed inset-0 z-20 bg-[#183038]/30 md:hidden" />}
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex h-[76px] items-center justify-between border-b border-[#d9e6e0]/90 bg-[#f6faf8]/90 px-4 backdrop-blur-md sm:px-7 lg:px-10">
          <div className="flex items-center gap-3"><button type="button" onClick={() => setMobileNav(true)} data-testid="button-open-navigation" className="focus-ring rounded-lg p-2 text-slate-500 hover:bg-white md:hidden"><Menu size={21} /></button><div><div className="flex items-center gap-2"><h1 className="text-lg font-extrabold tracking-[-.045em] text-[#243a3e] sm:text-[21px]">Operations overview</h1><Badge tone={mode === 'demo' ? 'amber' : 'teal'}>{mode === 'demo' ? 'Demo' : 'Live'}</Badge></div><p className="mt-0.5 hidden text-xs text-slate-500 sm:block">Northline Solar Facility <span className="mx-1 text-slate-300">/</span> telemetry health at a glance</p></div></div>
          <div className="flex items-center gap-2 sm:gap-4"><div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold sm:flex ${connected ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-teal-500 pulse-soft' : 'bg-rose-500'}`} />{connected ? 'Stream connected' : 'Stream offline'}</div><span className="hidden h-5 w-px bg-[#d6e3dd] sm:block" /><button type="button" onClick={() => setPaused(!paused)} data-testid="button-toggle-stream" className="focus-ring rounded-lg p-2 text-slate-500 transition-colors hover:bg-white hover:text-teal-700">{paused ? <Play size={17} /> : <Pause size={17} />}</button><button type="button" onClick={() => setSettingsOpen(true)} data-testid="button-header-settings" className="focus-ring rounded-lg border border-[#d8e5df] bg-white p-2 text-slate-500 transition-colors hover:border-teal-300 hover:text-teal-700"><Settings2 size={17} /></button></div>
        </header>
        <div className="grid-faint min-h-[calc(100dvh-76px)] px-4 py-6 sm:px-7 sm:py-8 lg:px-10">
          <div className="mx-auto max-w-[1440px]">
            <section className="animate-rise-in mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-medium uppercase tracking-[.18em] text-teal-700">Facility pulse / 08:42:16 UTC</p><h2 className="mt-2 text-[26px] font-extrabold tracking-[-.055em] text-[#294044] sm:text-[31px]">Keep the current flowing.</h2><p className="mt-1 max-w-xl text-sm text-slate-500">A live inventory of every discovered endpoint, with the raw signal never more than one click away.</p></div><div className="flex items-center gap-2"><button type="button" onClick={() => setNow(Date.now())} data-testid="button-refresh-dashboard" className="focus-ring inline-flex items-center gap-2 rounded-lg border border-[#d1e0da] bg-white px-3 py-2 text-xs font-bold text-[#4c6264] shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-300 hover:text-teal-700"><RefreshCw size={14} />Refresh</button><button type="button" onClick={exportSnapshot} data-testid="button-export-snapshot" className="focus-ring inline-flex items-center gap-2 rounded-lg bg-[#203d44] px-3 py-2 text-xs font-bold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-[#2b5159]"><ArrowDownToLine size={14} />Export</button></div></section>
            <section className="grid animate-rise-in grid-cols-2 gap-3 stagger-1 lg:grid-cols-4"><MetricCard icon={Zap} label="Output now" value={`${totalPower.toFixed(1)} kW`} detail={`Across ${devices.filter((device) => device.type === 'Power inverter').length} inverter endpoints`} points={[168, 174, 170, 179, 177, 184, 180, 186, 184]} /><MetricCard icon={Gauge} label="Fleet availability" value={`${(devices.length ? (online / devices.length) * 100 : 0).toFixed(1)}%`} detail={`${online} of ${devices.length} reporting`} points={[96, 97, 95, 96, 98, 97, 98, 97]} /><MetricCard icon={AlertTriangle} label="Attention needed" value={`${alerts}`} detail={alerts ? 'Review stale or offline endpoints' : devices.length ? 'All endpoints are healthy' : 'Waiting for first MQTT message'} points={[1, 1, 2, 1, 2, 2, 1, alerts]} tone={alerts ? 'amber' : 'teal'} /><MetricCard icon={Activity} label="Messages / min" value={devices.length ? 'Live' : '—'} detail={devices.length ? 'Latest MQTT activity' : 'No topic messages yet'} points={[122, 135, 129, 151, 144, 166, 158, 184]} /></section>
            <div className="mt-6 grid animate-rise-in gap-6 stagger-2 xl:grid-cols-[minmax(330px,1.02fr)_minmax(440px,1.5fr)]">
              <section className="overflow-hidden rounded-xl border border-[#d8e5df] bg-white shadow-[0_3px_14px_rgba(24,42,43,.035)]"><div className="border-b border-[#e1ebe6] px-4 py-4 sm:px-5"><div className="flex items-center justify-between"><div><div className="flex items-center gap-2"><h3 className="text-sm font-extrabold text-[#2b4346]">Discovered devices</h3><span className="rounded-full bg-[#e7f3ef] px-2 py-0.5 mono text-[10px] font-medium text-teal-700">{devices.length}</span></div><p className="mt-1 text-[11px] text-slate-500">Identity inferred from incoming JSON</p></div><button type="button" onClick={() => setFilter('all')} data-testid="button-clear-device-filter" className="focus-ring rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-teal-700"><SlidersHorizontal size={16} /></button></div><div className="mt-4 flex gap-2"><div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-2.5 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} data-testid="input-device-search" placeholder="Search devices or sites" className="focus-ring w-full rounded-md border border-[#d9e5e0] bg-[#f8fbf9] py-2 pl-9 pr-2 text-xs outline-none focus:border-teal-400" /></div><select value={filter} onChange={(event) => setFilter(event.target.value as 'all' | DeviceStatus)} data-testid="select-device-filter" className="focus-ring rounded-md border border-[#d9e5e0] bg-[#f8fbf9] px-2 text-[11px] font-semibold text-slate-600 outline-none"><option value="all">All status</option><option value="online">Online</option><option value="stale">Stale</option><option value="offline">Offline</option></select></div></div><div className="max-h-[390px] overflow-y-auto scrollbar-thin">{filteredDevices.length ? filteredDevices.map((device) => <DeviceRow key={device.id} device={device} selected={selected?.id === device.id} onSelect={() => selectDevice(device.id)} />) : <div className="flex flex-col items-center px-6 py-14 text-center"><Search size={24} className="text-slate-300" /><p className="mt-3 text-sm font-bold text-slate-500">No devices match</p><p className="mt-1 text-xs text-slate-400">Try a different search or status.</p></div>}</div><div className="border-t border-[#e1ebe6] bg-[#fbfdfc] px-5 py-3"><button type="button" onClick={() => setSettingsOpen(true)} data-testid="button-discover-device" className="focus-ring flex items-center gap-2 text-xs font-bold text-teal-700 hover:text-teal-900"><Database size={14} />Configure discovery source<ChevronRight size={13} /></button></div></section>
              <section className="min-w-0 overflow-hidden rounded-xl border border-[#d8e5df] bg-white shadow-[0_3px_14px_rgba(24,42,43,.035)]"><div className="flex flex-col justify-between gap-3 border-b border-[#e1ebe6] px-4 py-4 sm:flex-row sm:items-center sm:px-5"><div><div className="flex items-center gap-2"><h3 className="text-sm font-extrabold text-[#2b4346]">Telemetry inspector</h3><Badge tone={selected?.status === 'online' ? 'teal' : selected?.status === 'stale' ? 'amber' : 'rose'}><StatusDot status={selected?.status || 'offline'} />{selected?.status}</Badge></div><p className="mt-1 text-[11px] text-slate-500">Raw payload · <span className="mono text-slate-600">{selected?.id}</span> · nested fields discovered automatically</p></div><div className="flex items-center gap-2"><span className="mono text-[10px] text-slate-400">{selected ? formatLastSeen(selected.lastSeen, now) : '—'}</span><button type="button" onClick={() => selected && copyField(JSON.stringify(selected.telemetry, null, 2))} data-testid="button-copy-payload" className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-[#d8e5df] px-2.5 py-1.5 text-[11px] font-bold text-slate-500 hover:border-teal-300 hover:text-teal-700"><Copy size={12} />Copy JSON</button></div></div><div className="max-h-[430px] overflow-y-auto px-3 py-3 scrollbar-thin"><div className="mb-2 flex items-center gap-2 rounded-lg border border-[#e3eee9] bg-[#f5faf7] px-3 py-2.5"><Code2 size={15} className="text-teal-700" /><span className="mono truncate text-[11px] text-slate-500">{rawTopic}</span></div>{selected ? <FieldTree value={selected.telemetry} onCopy={copyField} /> : <div className="py-16 text-center text-sm text-slate-400">Select a device to inspect its payload.</div>}</div><div className="border-t border-[#e1ebe6] bg-[#fbfdfc] px-5 py-3"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[11px] text-slate-500"><span className="h-1.5 w-1.5 rounded-full bg-teal-500" />Payload schema is not fixed</div><button type="button" onClick={() => selected && copyField(JSON.stringify(selected.telemetry))} data-testid="button-copy-compact-json" className="focus-ring text-[11px] font-bold text-teal-700 hover:text-teal-900">Copy compact</button></div><div className="mt-3 overflow-hidden rounded-lg border border-[#dfeae5]"><div className="flex items-center justify-between bg-[#172c32] px-3 py-2"><p className="mono text-[10px] uppercase tracking-[.14em] text-[#8ee4cf]">Incoming raw MQTT data</p><span className="mono text-[10px] text-[#8aa8a1]">{selected ? `${flattenJson(selected.telemetry).length} fields` : 'waiting'}</span></div><div className="max-h-52 overflow-auto"><table className="w-full text-left"><thead className="sticky top-0 bg-[#edf6f1]"><tr><th className="px-3 py-2 mono text-[10px] font-bold uppercase tracking-[.12em] text-[#53706c]">Field path</th><th className="px-3 py-2 mono text-[10px] font-bold uppercase tracking-[.12em] text-[#53706c]">Value</th><th className="px-3 py-2 mono text-[10px] font-bold uppercase tracking-[.12em] text-[#53706c]">Type</th></tr></thead><tbody className="divide-y divide-[#dce9e3] bg-white">{selected ? flattenJson(selected.telemetry).map((row) => <tr key={row.path} className="hover:bg-[#f4faf7]"><td className="max-w-[180px] truncate px-3 py-2 mono text-[11px] font-medium text-[#426064]" title={row.path}>{row.path}</td><td className="max-w-[230px] truncate px-3 py-2 mono text-[11px] text-[#30494c]" title={row.value}>{row.value}</td><td className="px-3 py-2 mono text-[10px] uppercase text-teal-700">{row.type}</td></tr>) : <tr><td colSpan={3} className="px-3 py-8 text-center text-xs text-slate-400">Waiting for the first MQTT payload.</td></tr>}</tbody></table></div></div></div></section>
            </div>
            <div className="mt-6 grid animate-rise-in gap-6 stagger-3 xl:grid-cols-[1.5fr_1fr]">
              <section className="rounded-xl border border-[#d8e5df] bg-white p-4 shadow-[0_3px_14px_rgba(24,42,43,.035)] sm:p-5"><div className="flex items-center justify-between"><div><h3 className="text-sm font-extrabold text-[#2b4346]">Fleet output</h3><p className="mt-1 text-[11px] text-slate-500">Power contribution by endpoint · current window</p></div><span className="mono text-[10px] text-slate-400">kW / NOW</span></div><div className="mt-5 space-y-4">{devices.filter((device) => device.type === 'Power inverter').map((device) => { const power = numberFrom(device, ['power', 'active_kw']); const width = Math.min(100, (power / 210) * 100); return <div key={device.id} className="flex items-center gap-3"><div className="w-[92px] shrink-0"><p className="text-xs font-bold text-[#40585a]">{device.name}</p><p className="mono mt-0.5 text-[10px] text-slate-400">{device.id}</p></div><div className="h-2 flex-1 overflow-hidden rounded-full bg-[#edf2ef]"><div className={`h-full rounded-full transition-all duration-700 ${device.status === 'online' ? 'bg-[#2caa94]' : device.status === 'stale' ? 'bg-[#e7af43]' : 'bg-[#d87864]'}`} style={{ width: `${width}%` }} /></div><span className="mono w-[62px] text-right text-xs font-medium text-[#466063]">{power.toFixed(1)}</span></div>; })}</div><div className="mt-5 border-t border-[#e6eee9] pt-4"><div className="flex items-center justify-between text-[11px]"><span className="font-bold text-slate-500">Fleet nominal capacity</span><span className="mono text-[#35565a]">1.05 MW</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#edf2ef]"><div className="h-full w-[51%] rounded-full bg-[#f0bf5a]" /></div></div></section>
              <section className="rounded-xl border border-[#d8e5df] bg-white shadow-[0_3px_14px_rgba(24,42,43,.035)]"><div className="flex items-center justify-between border-b border-[#e1ebe6] px-5 py-4"><div><h3 className="text-sm font-extrabold text-[#2b4346]">Alert feed</h3><p className="mt-1 text-[11px] text-slate-500">Conditions requiring attention</p></div><span className="rounded-full bg-amber-50 px-2 py-1 mono text-[10px] font-bold text-amber-800">{alerts} open</span></div><div className="divide-y divide-[#e7efeb]">{devices.filter((device) => device.status !== 'online').map((device) => <div key={device.id} className="flex gap-3 px-5 py-4 transition-colors hover:bg-[#fbfdfc]"><div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${device.status === 'offline' ? 'bg-rose-50 text-rose-600' : 'bg-amber-50 text-amber-700'}`}>{device.status === 'offline' ? <WifiOff size={14} /> : <AlertTriangle size={14} />}</div><div className="min-w-0 flex-1"><p className="text-xs font-bold text-[#3b5254]">{device.name} <span className="font-normal text-slate-400">· {device.status === 'offline' ? 'connection lost' : 'telemetry delayed'}</span></p><p className="mt-1 text-[11px] leading-4 text-slate-500">{device.status === 'offline' ? 'No message received for over 1 hour.' : 'Last message is older than the 5 minute threshold.'}</p><p className="mono mt-2 text-[10px] text-slate-400">{formatLastSeen(device.lastSeen, now)}</p></div><button type="button" onClick={() => selectDevice(device.id)} data-testid={`button-review-alert-${device.id}`} className="focus-ring self-center rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-teal-700"><ChevronRight size={16} /></button></div>)}{!alerts && <div className="flex flex-col items-center px-5 py-12 text-center"><ShieldCheck size={28} className="text-teal-500" /><p className="mt-3 text-sm font-bold text-[#42605b]">No active alerts</p><p className="mt-1 text-xs text-slate-400">Every discovered endpoint is reporting on time.</p></div>}</div></section>
            </div>
            <footer className="mt-7 flex flex-col justify-between gap-2 border-t border-[#d7e4de] pt-4 text-[10px] text-slate-400 sm:flex-row"><div className="flex items-center gap-3"><span className="mono uppercase tracking-[.12em]">NORTHLINE / OPS-01</span><span className="h-3 w-px bg-[#cfded7]" /><span className="flex items-center gap-1.5"><HardDrive size={11} />Browser-local session</span></div><div className="flex items-center gap-3"><span>Messages retained in memory only</span><button type="button" onClick={() => window.alert('Northline SCADA Monitor · telemetry is held in browser memory for this session.')} data-testid="button-open-help" className="focus-ring flex items-center gap-1 font-bold text-teal-700 hover:text-teal-900"><CircleHelp size={12} />About this view</button></div></footer>
          </div>
        </div>
      </main>
      <BrokerPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} mode={mode} setMode={changeMode} connected={connected} onConnect={connect} onDisconnect={disconnect} error={error} />
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <Switch><Route path="/" component={AppShell} /><Route component={NotFound} /></Switch>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RoutedErrorBoundary><Router /></RoutedErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;