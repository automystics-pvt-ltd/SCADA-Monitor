import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';
import { LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Activity, AlertCircle, AlertTriangle, Check, ChevronRight,
  Code2, Copy, Database, Gauge, Layers3, LayoutDashboard,
  Link2, Menu, Play, PlugZap, Radio, RefreshCw, Settings2,
  Thermometer, Wifi, WifiOff, X, Zap, Sun, Moon, Bell, User, FileText
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
  pendingMessages: number;
  lastSnapshotAt?: string;
  error?: string;
};

const MODBUS_COLUMNS = [
  'timestamp', 'date', 'date_iso_8601', 'bdate', 'server_id', 'bserver_id',
  'addr', 'baddr', 'full_addr', 'size', 'data', 'raw_data', 'server_name', 'ip', 'name',
] as const;

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function CustomBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'destructive' }) {
  const tones = {
    neutral: 'bg-slate-800 text-slate-300 border-slate-700',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    destructive: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}

const electricalData = Array.from({ length: 24 }).map((_, i) => ({
  time: `${i}:00`,
  vab: 770 + Math.random() * 6,
  vbc: 772 + Math.random() * 6,
  vca: 775 + Math.random() * 6,
  ia: 23 + Math.random() * 1.5,
  ib: 23.5 + Math.random() * 1.5,
  ic: 23.2 + Math.random() * 1.5,
}));

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


function Sidebar({ onSettings, mobileOpen, onClose }: any) {
  return (
    <aside className={`fixed inset-y-0 left-0 z-30 flex w-[260px] flex-col bg-[#0b0f19] border-r border-[#1e293b] transition-transform duration-300 md:static md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex h-[72px] items-center px-6 border-b border-[#1e293b]">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded bg-orange-500/20 text-orange-500">
            <Sun size={20} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-100">Solar SCADA</h1>
            <p className="text-[9px] text-slate-500 uppercase tracking-widest">Monitoring System</p>
          </div>
        </div>
      </div>
      
      <div className="flex-1 py-6 px-4 overflow-y-auto scrollbar-thin">
        <div className="mb-8">
          <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Overview</p>
          <nav className="space-y-1.5">
            <NavItem icon={LayoutDashboard} label="Dashboard" active />
            <NavItem icon={Layers3} label="Plant Overview" />
          </nav>
        </div>
        
        <div className="mb-8">
          <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Monitoring</p>
          <nav className="space-y-1.5">
            <NavItem icon={Zap} label="Inverters" hasArrow />
            <NavItem icon={Activity} label="Live Data" />
            <NavItem icon={Gauge} label="Energy Analytics" />
            <NavItem icon={AlertTriangle} label="Alarms & Events" />
          </nav>
        </div>

        <div>
          <p className="px-3 mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Insights</p>
          <nav className="space-y-1.5">
            <NavItem icon={FileText} label="Reports" />
            <NavItem icon={Activity} label="Performance" />
            <NavItem icon={Settings2} label="Settings" onClick={onSettings} />
          </nav>
        </div>
      </div>
    </aside>
  );
}

function NavItem({ icon: Icon, label, active, hasArrow, onClick }: any) {
  return (
    <button onClick={onClick} className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all ${active ? 'bg-[#1e293b] text-slate-100' : 'text-slate-400 hover:text-slate-200 hover:bg-[#1e293b]/50'}`}>
      <div className="flex items-center gap-3 font-medium">
        <Icon size={18} className={active ? 'text-orange-500' : ''} />
        <span>{label}</span>
      </div>
      {hasArrow && <ChevronRight size={14} className="text-slate-500" />}
    </button>
  );
}

function Header({ toggleMobileNav }: any) {
  return (
    <header className="h-[72px] bg-[#0b0f19] border-b border-[#1e293b] flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-4">
        <button className="md:hidden text-slate-400" onClick={toggleMobileNav}>
          <Menu size={20} />
        </button>
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-slate-100 tracking-tight">TRN246 Solar Plant</h2>
            <CustomBadge tone="success"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-soft" />LIVE</CustomBadge>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">Utility-scale PV • 23 Aug 2026</p>
        </div>
      </div>
      
      <div className="hidden lg:flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <Sun size={14} className="text-slate-400" />
          <span>32°C Clear Sky</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <Zap size={14} className="text-slate-400" />
          <span>825 W/m²</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <RefreshCw size={14} className="text-slate-400" />
          <span>Updated 17:31:19</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#111827] border border-[#1e293b] text-xs text-slate-300">
          <Activity size={14} className="text-slate-400" />
          <span>Auto-refresh 60s</span>
        </div>
        
        <div className="flex items-center gap-3 border-l border-[#1e293b] pl-6 ml-2">
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"><Moon size={16} /></button>
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors relative">
            <Bell size={16} />
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-rose-500" />
          </button>
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] transition-colors"><User size={16} /></button>
        </div>
      </div>
    </header>
  );
}

function KpiCard({ title, value, unit, subtext, icon: Icon, colorClass, borderClass }: any) {
  return (
    <div className={`bg-[#111827] border ${borderClass || 'border-[#1e293b]'} rounded-xl p-4 flex flex-col justify-between hover:border-slate-600 transition-colors`}>
      <div className="flex items-start justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</h3>
        <div className={`p-1.5 rounded text-[14px] ${colorClass}`}>
          <Icon size={14} />
        </div>
      </div>
      <div className="mt-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold text-slate-100">{value}</span>
          {unit && <span className="text-[11px] font-medium text-slate-500">{unit}</span>}
        </div>
        {subtext && <p className="text-[10px] text-slate-500 mt-1">{subtext}</p>}
      </div>
    </div>
  );
}

function ElectricalParametersChart() {
  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-slate-400" />
          <h3 className="text-sm font-bold text-slate-200">Electrical Parameters</h3>
        </div>
      </div>
      
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-4">Phase Voltages (V)</p>
          <div className="h-[100px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={electricalData}>
                <Tooltip contentStyle={{ backgroundColor: '#0f1423', borderColor: '#1e293b', fontSize: '12px' }} itemStyle={{ color: '#e2e8f0' }} />
                <Line type="monotone" dataKey="vab" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="vbc" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="vca" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-4 border-t border-[#1e293b] pt-3">
            <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]" /><span className="text-[9px] text-slate-300 font-medium">AB 773.6V</span></div>
            <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#10b981]" /><span className="text-[9px] text-slate-300 font-medium">BC 773.6V</span></div>
            <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]" /><span className="text-[9px] text-slate-300 font-medium">CA 775.7V</span></div>
          </div>
        </div>
        
        <div className="flex">
          <div className="flex-1">
             <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-4">Phase Currents (A)</p>
             <div className="h-[100px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={electricalData}>
                  <Tooltip contentStyle={{ backgroundColor: '#0f1423', borderColor: '#1e293b', fontSize: '12px' }} itemStyle={{ color: '#e2e8f0' }} />
                  <Line type="monotone" dataKey="ia" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ib" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ic" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
             </div>
             <div className="flex gap-4 mt-4 border-t border-[#1e293b] pt-3">
                <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6]" /><span className="text-[9px] text-slate-300 font-medium">A 23.7A</span></div>
                <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#10b981]" /><span className="text-[9px] text-slate-300 font-medium">B 23.8A</span></div>
                <div className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b]" /><span className="text-[9px] text-slate-300 font-medium">C 23.7A</span></div>
             </div>
          </div>
          <div className="w-[120px] flex flex-col justify-center pl-6 ml-6 border-l border-[#1e293b]">
             <div className="mb-6">
               <div className="flex items-center gap-2 mb-1">
                 <div className="w-[22px] h-[22px] rounded-full border-[2.5px] border-emerald-500" />
                 <span className="text-[16px] font-bold text-slate-100">1.000</span>
               </div>
               <p className="text-[8px] text-slate-500 uppercase tracking-wider font-semibold">Power Factor</p>
             </div>
             <div>
               <div className="flex items-center gap-2 mb-1">
                 <div className="w-[22px] h-[22px] rounded-full border-[2.5px] border-blue-500" />
                 <span className="text-[16px] font-bold text-slate-100">50.0 <span className="text-[9px] text-slate-400">Hz</span></span>
               </div>
               <p className="text-[8px] text-slate-500 uppercase tracking-wider font-semibold">Frequency</p>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function InverterOverviewTable({ devices }: { devices: Device[] }) {
  const inverters = devices.filter(d => d.type === 'Power inverter');
  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers3 size={16} className="text-slate-400" />
          <h3 className="text-sm font-bold text-slate-200">Inverter Overview</h3>
        </div>
        <button className="text-[10px] text-slate-500 hover:text-slate-300">View all</button>
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
              <tr key={inv.id} className="hover:bg-[#1e293b]/30">
                <td className="py-2.5 text-[11px] font-medium text-slate-300">{inv.name.replace('Inverter ', 'INV')}</td>
                <td className="py-2.5">
                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${inv.status === 'online' ? 'bg-emerald-500/10 text-emerald-400' : inv.status === 'offline' ? 'bg-rose-500/10 text-rose-400' : 'bg-amber-500/10 text-amber-400'}`}>
                    <span className={`w-1 h-1 rounded-full ${inv.status === 'online' ? 'bg-emerald-400 pulse-soft' : inv.status === 'offline' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                    Online
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

function EnergySummaryChart() {
  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex flex-col">
           <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-1">
             <Activity size={14} className="text-slate-400" /> Energy Summary
           </h3>
        </div>
        <div className="flex bg-[#0f1423] p-0.5 rounded border border-[#1e293b]">
          <button className="px-2 py-1 text-[9px] bg-[#1e293b] rounded font-medium text-slate-200 shadow-sm">Daily</button>
          <button className="px-2 py-1 text-[9px] text-slate-500 font-medium">Monthly</button>
          <button className="px-2 py-1 text-[9px] text-slate-500 font-medium">Yearly</button>
        </div>
      </div>
      <div className="mb-6">
        <span className="text-2xl font-bold text-slate-100 tracking-tight">14.13</span> <span className="text-[11px] text-slate-500">MWh today</span>
      </div>
      <div className="flex-1 min-h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={energyData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <Tooltip cursor={{ fill: '#1e293b' }} contentStyle={{ backgroundColor: '#0f1423', borderColor: '#1e293b', fontSize: '12px' }} itemStyle={{ color: '#e2e8f0' }} />
            <Bar dataKey="value" fill="#f97316" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between text-[9px] text-slate-500 mt-2 font-mono">
        <span>00</span><span>02</span><span>04</span><span>06</span><span>08</span><span>10</span><span>12</span><span>14</span><span>16</span><span>18</span><span>20</span><span>22</span>
      </div>
    </div>
  );
}

function PowerTrendChart({ currentKw }: { currentKw: number }) {
  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-slate-400" />
          <h3 className="text-sm font-bold text-slate-200">Power Trend</h3>
        </div>
        <span className="text-[9px] text-slate-500 uppercase tracking-wider font-semibold">Real time</span>
      </div>
      <div className="mb-6">
        <span className="text-2xl font-bold text-slate-100 tracking-tight">{currentKw.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> <span className="text-[11px] text-slate-500">kW right now</span>
      </div>
      <div className="flex-1 min-h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={powerTrendData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="colorPower" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25}/>
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="#1e293b" vertical={false} />
            <XAxis dataKey="time" hide />
            <Tooltip contentStyle={{ backgroundColor: '#0f1423', borderColor: '#1e293b', fontSize: '12px' }} itemStyle={{ color: '#e2e8f0' }} />
            <Area type="monotone" dataKey="power" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#colorPower)" isAnimationActive={false} />
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
    </div>
  );
}

function PowerDistributionChart() {
  return (
    <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-5 flex flex-col h-full">
      <div className="flex items-center gap-2 mb-6">
        <Activity size={14} className="text-slate-400" />
        <h3 className="text-sm font-bold text-slate-200">Power Distribution</h3>
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
              <Tooltip contentStyle={{ backgroundColor: '#0f1423', borderColor: '#1e293b', fontSize: '12px' }} itemStyle={{ color: '#e2e8f0' }} />
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

function SidePanels({ devices }: { devices: Device[] }) {
  const met = devices.find(d => d.id.startsWith('met'));
  const ambient = numberFrom(met as any, ['telemetry', 'ambient', 'temperature_c'], 32.0);
  const irradiance = numberFrom(met as any, ['telemetry', 'irradiance', 'ghi_w_m2'], 825);
  
  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-4 flex-1">
        <div className="flex items-center gap-2 mb-4">
          <Sun size={14} className="text-slate-400" />
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Environment</h3>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 bg-[#1e293b]/50 p-1.5 rounded text-rose-400"><Thermometer size={12} /></div>
            <span className="text-[10px] text-slate-400 flex-1 ml-3">Internal Temp</span>
            <span className="text-[11px] font-bold text-slate-200">25.0°C</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 bg-[#1e293b]/50 p-1.5 rounded text-orange-400"><Sun size={12} /></div>
            <span className="text-[10px] text-slate-400 flex-1 ml-3">Irradiance</span>
            <span className="text-[11px] font-bold text-slate-200">{irradiance} W/m²</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 bg-[#1e293b]/50 p-1.5 rounded text-blue-400"><Thermometer size={12} /></div>
            <span className="text-[10px] text-slate-400 flex-1 ml-3">Ambient Temp</span>
            <span className="text-[11px] font-bold text-slate-200">{ambient}°C</span>
          </div>
        </div>
      </div>
      
      <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-4 flex-1">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={14} className="text-slate-400" />
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Alarms & Faults</h3>
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
      
      <div className="bg-[#111827] border border-[#1e293b] rounded-xl p-4 flex-1">
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

function DetailedLiveDataTable({ rows, persistence }: { rows: ModbusRow[]; persistence: PersistenceStatus }) {
  const getCategory = (row: ModbusRow) => {
    const name = String(row.name || '').toLowerCase();
    if (name.includes('voltage') || name.includes('current')) return 'Electrical';
    if (name.includes('power') || name.includes('frequency')) return 'Power';
    if (name.includes('temp') || name.includes('irradiance')) return 'Environment';
    if (name.includes('alarm') || name.includes('fault')) return 'Alarms';
    return 'Device';
  };
  
  return (
    <section className="bg-[#111827] border border-[#1e293b] rounded-xl overflow-hidden flex flex-col mt-6">
      <div className="flex flex-col justify-between gap-3 border-b border-[#1e293b] p-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Database size={16} className="text-slate-400" />
            <h3 className="text-sm font-bold text-slate-200">Detailed Live Data</h3>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-2.5 py-1 rounded text-[9px] font-bold uppercase tracking-wider ${persistence.error ? 'bg-rose-500/10 text-rose-400' : 'bg-[#1e293b] text-slate-300'}`}>
            {persistence.error ? 'Storage retrying' : `Saving every ${persistence.intervalMinutes} min`}
          </span>
          <button className="text-[10px] text-slate-500 hover:text-slate-300">View all</button>
        </div>
      </div>
      
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-left whitespace-nowrap min-w-[1000px]">
          <thead className="bg-[#0b0f19]">
            <tr>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Category</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Parameter</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Raw Value</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Scaled Value</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Unit</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Register Address</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Data Quality</th>
              <th className="px-5 py-3 text-[9px] font-semibold uppercase tracking-wider text-slate-500">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1e293b]">
            {rows.length ? rows.map((row, index) => {
               const rawValue = formatValue(row.raw_data ?? row.data);
               const scaledValue = formatValue(row.data);
               return (
                 <tr key={`${modbusRowKey(row)}-${index}`} className="hover:bg-[#1e293b]/40 transition-colors">
                   <td className="px-5 py-2.5 text-[11px] text-slate-300 flex items-center gap-2">
                     <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                     {getCategory(row)}
                   </td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-300 font-medium">{String(row.name || '—')}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{rawValue}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-200 font-mono font-bold">{scaledValue}</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400">—</td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400 font-mono">{String(row.full_addr || row.addr || '—')}</td>
                   <td className="px-5 py-2.5">
                     <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[9px] font-bold uppercase">
                       <span className="w-1 h-1 rounded-full bg-emerald-400" /> Good
                     </span>
                   </td>
                   <td className="px-5 py-2.5 text-[11px] text-slate-400">{String(row.server_name || 'Modbus')}</td>
                 </tr>
               );
            }) : (
               <tr><td colSpan={8} className="px-5 py-10 text-center text-xs text-slate-500">Waiting for Modbus parameters...</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CompletePayloadInspector({ rawPayload, rawJson, topic, onCopy }: any) {
  const rows = rawJson ? flattenJson(rawJson) : [];
  return (
    <section className="bg-[#111827] border border-[#1e293b] rounded-xl overflow-hidden mt-6">
      <div className="flex flex-col justify-between gap-3 border-b border-[#1e293b] p-5 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-3 mb-1">
             <Code2 size={16} className="text-slate-400" />
             <h3 className="text-sm font-bold text-slate-200">Raw MQTT Payload</h3>
             <CustomBadge tone="success"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-soft" />Live</CustomBadge>
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-1">{topic}</p>
        </div>
        <button onClick={() => onCopy(rawPayload)} className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1e293b] text-[11px] font-medium text-slate-200 hover:bg-slate-700 transition-colors border border-[#334155]">
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
                   <tr key={i} className="hover:bg-[#1e293b]/30">
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
  const handleConnect = () => { localStorage.setItem('northline-broker-url', url); localStorage.setItem('northline-broker-topic', topic); onConnect(url, topic); };
  
  return (
    <>
      {open && <button type="button" aria-label="Close broker settings" onClick={onClose} className="fixed inset-0 z-40 bg-[#0b0f19]/80 backdrop-blur-sm cursor-default" />}
      <section className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[400px] flex-col border-l border-[#1e293b] bg-[#111827] shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between border-b border-[#1e293b] px-6 py-5">
          <div>
            <h2 className="text-lg font-bold text-slate-100 tracking-tight">Settings</h2>
            <p className="text-xs text-slate-400 mt-1">Configure telemetry connection</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-200 hover:bg-[#1e293b] rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6 scrollbar-thin">
          <div className="bg-[#0b0f19] border border-[#1e293b] p-1.5 rounded-lg flex gap-1">
             <button onClick={() => setMode('demo')} className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-md transition-colors ${mode === 'demo' ? 'bg-[#1e293b] text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}><Play size={14} /> Demo Stream</button>
             <button onClick={() => setMode('live')} className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-md transition-colors ${mode === 'live' ? 'bg-[#1e293b] text-emerald-400' : 'text-slate-400 hover:text-slate-200'}`}><Wifi size={14} /> Live Broker</button>
          </div>
          
          <div className="space-y-4">
            <label className="block">
               <span className="block text-xs font-bold text-slate-300 mb-2">Broker Endpoint</span>
               <div className="relative">
                 <Link2 size={15} className="absolute left-3 top-3.5 text-slate-500" />
                 <input value={url} onChange={e => setUrl(e.target.value)} className="w-full bg-[#0b0f19] border border-[#1e293b] text-slate-200 text-xs py-3 pl-9 pr-3 rounded-lg focus:outline-none focus:border-blue-500 font-mono" />
               </div>
            </label>
            <label className="block">
               <span className="block text-xs font-bold text-slate-300 mb-2">Subscription Topic</span>
               <div className="relative">
                 <Radio size={15} className="absolute left-3 top-3.5 text-slate-500" />
                 <input value={topic} onChange={e => setTopic(e.target.value)} className="w-full bg-[#0b0f19] border border-[#1e293b] text-slate-200 text-xs py-3 pl-9 pr-3 rounded-lg focus:outline-none focus:border-blue-500 font-mono" />
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
        
        <div className="p-6 border-t border-[#1e293b] bg-[#111827]">
          {connected ? (
             <button onClick={onDisconnect} className="w-full flex items-center justify-center gap-2 py-3 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 text-sm font-bold rounded-lg transition-colors"><WifiOff size={16} /> Disconnect</button>
          ) : (
             <button onClick={handleConnect} className="w-full flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold rounded-lg shadow-lg shadow-blue-500/20 transition-colors"><PlugZap size={16} /> {mode === 'demo' ? 'Start Demo' : 'Connect to Broker'}</button>
          )}
        </div>
      </section>
    </>
  );
}

function AppShell() {
  const [devices, setDevices] = useState<Device[]>(initialDevices);
  const [mode, setMode] = useState<'demo' | 'live'>(() => (localStorage.getItem('northline-mode') as 'demo' | 'live') || 'live');
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [rawPayload, setRawPayload] = useState('Waiting for the first MQTT payload…');
  const [rawJson, setRawJson] = useState<JsonValue | null>(null);
  const [modbusRows, setModbusRows] = useState<ModbusRow[]>([]);
  const [persistence, setPersistence] = useState<PersistenceStatus>({ intervalMinutes: 15, pendingMessages: 0 });
  const [rawTopic, setRawTopic] = useState(DEFAULT_BROKER_TOPIC);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => { localStorage.setItem('northline-mode', mode); }, [mode]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10000); return () => window.clearInterval(timer); }, []);

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

  const totalAcPower = useMemo(() => devices.filter(d => d.status === 'online').reduce((sum, d) => sum + numberFrom(d, ['power', 'active_kw'], 0), 0), [devices]);
  const inverters = useMemo(() => devices.filter(d => d.type === 'Power inverter'), [devices]);
  const onlineInverters = inverters.filter(d => d.status === 'online').length;
  const totalInverters = inverters.length;
  const activeAlarms = useMemo(() => devices.reduce((sum, d) => sum + (Array.isArray(d.telemetry.alarms) ? d.telemetry.alarms.length : 0), 0), [devices]);

  return (
    <div className="flex h-screen bg-[#0b0f19] text-slate-200 overflow-hidden font-sans">
      <Sidebar onSettings={() => setSettingsOpen(true)} mobileOpen={mobileNav} onClose={() => setMobileNav(false)} />
      
      <div className="flex flex-col flex-1 min-w-0">
        <Header toggleMobileNav={() => setMobileNav(true)} />
        
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scrollbar-thin">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <KpiCard title="Total AC Power" value={totalAcPower.toLocaleString(undefined, { maximumFractionDigits: 2 })} unit="kW" icon={Zap} colorClass="bg-blue-500/10 text-blue-400" />
            <KpiCard title="Today's Energy" value="14.13" unit="MWh" icon={Sun} colorClass="bg-orange-500/10 text-orange-400" subtext="Daily energy" />
            <KpiCard title="Total Energy" value="31,457.28" unit="kWh" icon={Database} colorClass="bg-purple-500/10 text-purple-400" subtext="Lifetime energy" />
            <KpiCard title="Specific Yield" value="4.62" unit="kWh/kWp" icon={Activity} colorClass="bg-pink-500/10 text-pink-400" subtext="PR 87.3%" />
            <KpiCard title="Inverters Online" value={`${onlineInverters}/${totalInverters}`} icon={Check} colorClass="bg-emerald-500/10 text-emerald-400" subtext="100% online" />
            <KpiCard title="Active Alarms" value={activeAlarms.toString()} icon={AlertTriangle} colorClass="bg-emerald-500/10 text-emerald-400" subtext="All clear" />
          </div>
          
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
               <ElectricalParametersChart />
            </div>
            <div>
               <InverterOverviewTable devices={devices} />
            </div>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-5 gap-6">
             <div className="xl:col-span-1">
               <EnergySummaryChart />
             </div>
             <div className="xl:col-span-2">
               <PowerTrendChart currentKw={totalAcPower} />
             </div>
             <div className="xl:col-span-1">
               <PowerDistributionChart />
             </div>
             <div className="xl:col-span-1">
               <SidePanels devices={devices} />
             </div>
          </div>
          
          <DetailedLiveDataTable rows={modbusRows} persistence={persistence} />
          
          <CompletePayloadInspector rawPayload={rawPayload} rawJson={rawJson} topic={rawTopic} onCopy={handleCopy} />
          
        </main>
      </div>
       <BrokerPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} mode={mode} setMode={changeMode} connected={connected} onConnect={connect} onDisconnect={disconnect} error={error} />
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
