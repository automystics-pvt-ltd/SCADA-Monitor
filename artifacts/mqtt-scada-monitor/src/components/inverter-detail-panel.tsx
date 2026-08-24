import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Activity, X } from 'lucide-react';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type DeviceStatus = 'online' | 'stale' | 'offline';
type Device = {
  id: string;
  name: string;
  site: string;
  type: string;
  status: DeviceStatus;
  lastSeen: number;
  telemetry: Record<string, JsonValue>;
};

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
  if (typeof value !== 'object' || value === null) {
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

export default function InverterDetailPanel({ device, onClose }: { device: Device; onClose: () => void }) {
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
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${device.name} monitoring details`} tabIndex={-1} className="fixed inset-x-3 bottom-3 top-3 z-50 mx-auto flex min-h-0 max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#1e293b] bg-[#111827] shadow-2xl sm:inset-x-8 sm:bottom-8 sm:top-8">
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
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
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