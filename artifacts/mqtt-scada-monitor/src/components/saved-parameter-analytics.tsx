import React, { useState, useMemo } from 'react';
import { 
  Activity, AlertCircle, CheckCircle2, Clock, Database, 
  FileText, ActivitySquare, Cpu, BarChart3, ChevronLeft, ChevronRight, Hash
} from 'lucide-react';

export interface SavedParameterRecord {
  id: string;
  parameterName: string;
  sourceIdentity: string;
  deviceId?: string;
  deviceName?: string;
  category: 'kpi' | 'summary' | 'device' | 'status' | 'raw' | string;
  dataQuality: 'validated' | 'raw' | 'source-reported' | 'fault' | 'stale' | 'error' | string;
  value: number | string | boolean;
  unit?: string;
  timestamp: string | number;
  provenance?: string;
  originalValue?: string;
  transportRawValue?: string | null;
  sourceReportedValue?: string | null;
  validationStatus?: string;
  address?: string;
}

export interface SavedParameterAnalyticsProps {
  records: SavedParameterRecord[];
  isLoading?: boolean;
  error?: Error | null;
  selectedTimestamp?: string;
  totalRecords?: number;
  serverPage?: number;
  serverPageSize?: number;
  onServerPageChange?: (page: number) => void;
}

function KpiSection({ records }: { records: SavedParameterRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="section-kpi">
      {records.map(record => (
        <div key={record.id} className="scada-interactive-card relative overflow-hidden border border-emerald-500/20 bg-scada-surface p-4 shadow-sm" data-testid={`kpi-card-${record.id}`}>
          <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none text-emerald-500">
             <Activity size={48} />
          </div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-scada-muted truncate pr-2" title={record.parameterName}>{record.parameterName}</span>
            <CheckCircle2 size={14} className="text-emerald-500 shrink-0" />
          </div>
          <div className="text-2xl font-bold text-scada-text font-mono truncate">
            {typeof record.value === 'number' ? record.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(record.value)}
            {record.unit && <span className="ml-1 text-sm text-scada-muted font-sans tracking-normal">{record.unit}</span>}
          </div>
          <div className="mt-3 text-[10px] text-scada-muted flex items-center justify-between gap-2 border-t border-scada-border/50 pt-2">
             <span className="flex items-center gap-1 font-semibold uppercase tracking-wider"><Database size={10} /> Validated KPI</span>
             <span className="font-mono truncate max-w-[50%]">{record.sourceIdentity}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SummarySection({ records }: { records: SavedParameterRecord[] }) {
  if (records.length === 0) return null;
  const series = Object.values(records.reduce<Record<string, SavedParameterRecord[]>>((groups, record) => {
    (groups[record.sourceIdentity] ??= []).push(record);
    return groups;
  }, {})).map((items) => [...items].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()));
  return (
    <div data-testid="section-summary">
      <h3 className="text-xs font-bold uppercase tracking-widest text-scada-muted mb-3 flex items-center gap-2">
        <BarChart3 size={14} className="text-scada-accent"/> Validated saved time series
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
         {series.map(items => {
            const record = items.at(-1)!;
            const values = items.map(item => typeof item.value === 'number' ? item.value : Number.NaN).filter(Number.isFinite);
            const min = Math.min(...values);
            const max = Math.max(...values);
            const points = values.map((value, index) => {
              const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
              const y = max === min ? 50 : 100 - ((value - min) / (max - min)) * 100;
              return `${x},${y}`;
            }).join(' ');
            return (
            <div key={record.sourceIdentity} className="bg-scada-surface border border-scada-border rounded-lg p-3 shadow-sm" data-testid={`summary-card-${record.id}`}>
               <div className="text-[10px] font-bold text-scada-muted uppercase tracking-wider truncate" title={record.parameterName}>{record.parameterName}</div>
               <div className="mt-1 flex items-baseline justify-between gap-2">
                 <div className="text-lg font-bold font-mono text-scada-text truncate">
                   {typeof record.value === 'number' ? record.value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(record.value)}
                 </div>
                 {record.unit && <div className="text-[9px] font-bold uppercase tracking-wider text-scada-muted bg-scada-surface-raised px-1.5 py-0.5 rounded border border-scada-border/50">{record.unit}</div>}
               </div>
               <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={`${record.parameterName} saved time series`} className="mt-3 h-8 w-full overflow-visible">
                  <polyline points={points} fill="none" stroke="var(--scada-accent)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
               </svg>
               <div className="mt-2 flex justify-between text-[9px] uppercase tracking-wider text-scada-muted">
                 <span className="truncate pr-2">{record.sourceIdentity}</span>
                  <span className="font-mono shrink-0">{items.length} saved point{items.length === 1 ? '' : 's'}</span>
               </div>
            </div>
         )})}
      </div>
    </div>
  )
}

function DeviceSection({ records }: { records: SavedParameterRecord[] }) {
  const byDevice = useMemo(() => {
    const groups: Record<string, SavedParameterRecord[]> = {};
    for (const r of records) {
       const key = r.deviceName || r.deviceId || r.sourceIdentity;
       if (!groups[key]) groups[key] = [];
       groups[key].push(r);
    }
    return groups;
  }, [records]);

  if (Object.keys(byDevice).length === 0) return null;

  return (
    <div data-testid="section-device">
       <h3 className="text-xs font-bold uppercase tracking-widest text-scada-muted mb-3 flex items-center gap-2">
         <Cpu size={14} className="text-scada-accent"/> Device Comparisons
       </h3>
       <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
         {Object.entries(byDevice).map(([device, items]) => (
            <div key={device} className="border border-scada-border rounded-xl bg-scada-surface flex flex-col scada-interactive-card shadow-sm" data-testid={`device-card-${device}`}>
               <div className="p-3 border-b border-scada-border bg-scada-surface-raised rounded-t-xl flex items-center justify-between">
                  <h4 className="text-sm font-bold text-scada-text flex items-center gap-2 truncate">
                   <Hash size={14} className="text-scada-muted" />
                   {device}
                 </h4>
                 <span className="text-[10px] font-mono bg-scada-bg px-2 py-0.5 rounded border border-scada-border text-scada-muted">
                   {items.length} params
                 </span>
               </div>
               <div className="p-3 space-y-2 flex-1 flex flex-col justify-center">
                 {items.slice(0, 5).map(item => (
                    <div key={item.id} className="flex justify-between items-center text-sm border-b border-scada-border/30 last:border-0 pb-1.5 last:pb-0">
                      <span className="text-scada-muted text-[11px] font-medium truncate pr-2" title={item.parameterName}>{item.parameterName}</span>
                      <span className="font-mono font-bold text-scada-text text-[11px] whitespace-nowrap">
                        {typeof item.value === 'number' ? item.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(item.value)} 
                        {item.unit && <span className="text-[9px] font-sans font-normal ml-1 text-scada-muted">{item.unit}</span>}
                      </span>
                    </div>
                 ))}
                 {items.length > 5 && (
                   <div className="text-[9px] text-center text-scada-muted pt-2 uppercase tracking-widest font-bold">
                     + {items.length - 5} more parameters
                   </div>
                 )}
               </div>
            </div>
         ))}
       </div>
    </div>
  )
}

function RawEvidenceSection({ records }: { records: SavedParameterRecord[] }) {
  if (records.length === 0) return null;
  return (
    <div data-testid="section-raw">
       <h3 className="text-xs font-bold uppercase tracking-widest text-scada-muted mb-3 flex items-center gap-2">
         <ActivitySquare size={14} className="text-amber-500"/> Raw Evidence & Status
       </h3>
       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
         {records.map(record => {
            const isError = record.dataQuality === 'error' || record.dataQuality === 'fault';
            const colorClass = isError 
              ? 'border-red-500/30 bg-red-500/5 text-red-500' 
              : 'border-amber-500/30 bg-amber-500/5 text-amber-500';
            const bgBadgeClass = isError ? 'bg-red-500/10 text-red-600 border-red-500/20' : 'bg-amber-500/10 text-amber-600 border-amber-500/20';

            return (
              <div key={record.id} className={`border rounded-lg p-3 relative overflow-hidden ${colorClass}`} data-testid={`raw-card-${record.id}`}>
                 {isError && (
                   <div className="absolute -right-2 -top-2 opacity-5 pointer-events-none">
                     <AlertCircle size={64} />
                   </div>
                 )}
                 <div className="flex items-start justify-between relative z-10 gap-2 mb-2">
                   <div className="text-[10px] font-bold font-mono uppercase tracking-wider opacity-80 truncate">{record.sourceIdentity}</div>
                   <div className={`text-[8px] px-1.5 py-0.5 border rounded font-bold uppercase tracking-widest shrink-0 ${bgBadgeClass}`}>
                     {record.dataQuality}
                   </div>
                 </div>
                 <div className="text-sm font-mono break-all font-medium leading-tight">
                    {record.originalValue ?? String(record.value)} {record.unit && <span className="opacity-70 font-sans text-[10px] ml-1">{record.unit}</span>}
                 </div>
                 <div className="mt-2 pt-2 border-t border-current/10">
                   <div className="text-[10px] opacity-90 truncate uppercase tracking-widest font-bold" title={record.parameterName}>
                     {record.parameterName}
                   </div>
                   {record.provenance && (
                     <div className="mt-1 text-[9px] opacity-60 font-mono truncate" title={record.provenance}>
                       src: {record.provenance}
                     </div>
                   )}
                    <div className="mt-1 text-[9px] opacity-60 font-mono break-all">raw: {record.transportRawValue ?? 'not supplied'} · reported: {record.sourceReportedValue ?? 'not supplied'} · validation: {record.validationStatus ?? 'raw'}</div>
                 </div>
              </div>
            );
         })}
       </div>
    </div>
  )
}

function DetailTableSection({ records }: { records: SavedParameterRecord[] }) {
  const [page, setPage] = useState(1);
  const size = 10;
  const total = records.length;
  const pages = Math.ceil(total / size);
  
  const safePage = Math.min(Math.max(1, page), pages || 1);
  const current = records.slice((safePage - 1) * size, safePage * size);

  if (total === 0) return null;

  return (
    <div className="border border-scada-border bg-scada-surface rounded-xl overflow-hidden shadow-sm" data-testid="section-detail-table">
      <div className="p-3 border-b border-scada-border flex justify-between items-center bg-scada-surface-raised">
         <h3 className="text-xs font-bold uppercase tracking-widest text-scada-muted flex items-center gap-2">
           <FileText size={14} className="text-scada-accent"/> Detailed Evidence Record
         </h3>
         <span className="text-[10px] px-2 py-0.5 rounded bg-scada-bg border border-scada-border text-scada-muted font-mono">
           {total} records
         </span>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-left border-collapse min-w-[900px]">
          <thead>
            <tr className="border-b border-scada-border text-[9px] font-bold uppercase tracking-widest text-scada-muted bg-scada-bg/50">
              <th className="p-3 w-[140px]">Timestamp</th>
              <th className="p-3 w-[120px]">Identity</th>
              <th className="p-3 min-w-[150px]">Parameter</th>
              <th className="p-3 w-[100px]">Category</th>
              <th className="p-3 w-[100px]">Quality</th>
              <th className="p-3 text-right w-[140px]">Value</th>
              <th className="p-3 w-[100px]">Trace</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-scada-border text-sm">
            {current.map(record => (
              <tr key={record.id} className="hover:bg-scada-hover/50 transition-colors group">
                 <td className="p-3 font-mono text-[10px] text-scada-muted whitespace-nowrap">
                   {new Date(record.timestamp).toLocaleString(undefined, {
                     month: 'short', day: 'numeric',
                     hour: '2-digit', minute: '2-digit', second: '2-digit'
                   })}
                 </td>
                 <td className="p-3 font-mono text-[11px] font-semibold text-scada-text whitespace-nowrap">
                   {record.sourceIdentity}
                 </td>
                 <td className="p-3 text-scada-text text-[11px] font-medium">
                   {record.parameterName}
                 </td>
                 <td className="p-3">
                    <span className="px-1.5 py-0.5 rounded bg-scada-surface-raised border border-scada-border text-[9px] font-bold uppercase tracking-wider text-scada-muted whitespace-nowrap">
                      {record.category}
                    </span>
                 </td>
                 <td className="p-3">
                    <span className={`inline-flex whitespace-nowrap px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold ${
                      record.dataQuality === 'validated' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' :
                      record.dataQuality === 'error' || record.dataQuality === 'fault' ? 'bg-red-500/10 text-red-500 border border-red-500/20' :
                      'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                    }`}>
                      {record.dataQuality}
                    </span>
                 </td>
                 <td className="p-3 font-mono text-right text-scada-text text-[11px] whitespace-nowrap">
                   <span className="font-bold">
                     {typeof record.value === 'number' ? record.value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(record.value)}
                   </span>
                   {record.unit && <span className="text-scada-muted text-[10px] ml-1 font-sans font-normal">{record.unit}</span>}
                 </td>
                  <td className="p-3 align-top">
                    <details className="group">
                      <summary className="cursor-pointer text-[9px] font-bold uppercase tracking-wider text-scada-accent focus-ring">Evidence</summary>
                      <dl className="mt-2 grid gap-1 text-[9px] leading-relaxed text-scada-muted">
                        <div><dt className="inline font-semibold text-scada-text">Device: </dt><dd className="inline font-mono">{record.deviceName ?? record.deviceId ?? 'not supplied'}</dd></div>
                        <div><dt className="inline font-semibold text-scada-text">Source: </dt><dd className="inline font-mono break-all">{record.sourceIdentity}</dd></div>
                        <div><dt className="inline font-semibold text-scada-text">Original: </dt><dd className="inline font-mono break-all">{record.originalValue ?? String(record.value)}</dd></div>
                        <div><dt className="inline font-semibold text-scada-text">Transport raw: </dt><dd className="inline font-mono break-all">{record.transportRawValue ?? 'not supplied'}</dd></div>
                        <div><dt className="inline font-semibold text-scada-text">Source-reported: </dt><dd className="inline font-mono break-all">{record.sourceReportedValue ?? 'not supplied'}</dd></div>
                        <div><dt className="inline font-semibold text-scada-text">Validation: </dt><dd className="inline font-mono">{record.validationStatus ?? record.dataQuality}</dd></div>
                        <div><dt className="inline font-semibold text-scada-text">Provenance: </dt><dd className="inline font-mono">{record.provenance ?? 'saved-snapshot'}</dd></div>
                        {record.address && <div><dt className="inline font-semibold text-scada-text">Address: </dt><dd className="inline font-mono">{record.address}</dd></div>}
                      </dl>
                    </details>
                  </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="p-2 border-t border-scada-border flex items-center justify-between bg-scada-surface-raised">
          <button 
            type="button"
            disabled={safePage === 1} 
            onClick={() => setPage(p => p - 1)}
            className="p-1.5 text-scada-muted hover:text-scada-text disabled:opacity-30 disabled:hover:text-scada-muted transition-colors rounded hover:bg-scada-hover focus-ring"
            data-testid="pagination-prev"
            aria-label="Previous page"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-[10px] text-scada-muted font-mono uppercase tracking-widest font-bold">
            Page {safePage} of {pages}
          </span>
          <button 
            type="button"
            disabled={safePage === pages} 
            onClick={() => setPage(p => p + 1)}
            className="p-1.5 text-scada-muted hover:text-scada-text disabled:opacity-30 disabled:hover:text-scada-muted transition-colors rounded hover:bg-scada-hover focus-ring"
            data-testid="pagination-next"
            aria-label="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  )
}

export function SavedParameterAnalytics({ 
  records, 
  isLoading, 
  error, 
  selectedTimestamp,
  totalRecords = records.length,
  serverPage = 1,
  serverPageSize = records.length || 1,
  onServerPageChange,
}: SavedParameterAnalyticsProps) {
  if (error) {
    return (
      <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5 flex items-start gap-3 text-red-500" data-testid="analytics-error">
        <AlertCircle size={18} className="mt-0.5 shrink-0" />
        <div>
          <h3 className="text-sm font-bold uppercase tracking-wide">Analytics Unavailable</h3>
          <p className="text-xs opacity-80 mt-1">{error.message || 'Failed to load saved parameters.'}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 rounded-xl border border-scada-border border-dashed flex flex-col items-center justify-center text-scada-muted bg-scada-surface" data-testid="analytics-loading">
         <Clock size={24} className="mb-3 animate-pulse opacity-50 text-scada-accent" />
         <p className="text-xs uppercase tracking-widest font-bold">Loading historical evidence...</p>
      </div>
    );
  }

  if (!records || records.length === 0) {
    return (
      <div className="p-8 rounded-xl border border-scada-border bg-scada-surface flex flex-col items-center justify-center text-scada-muted shadow-sm" data-testid="analytics-empty">
         <Database size={24} className="mb-3 opacity-30" />
         <p className="text-xs uppercase tracking-widest font-bold">No Records Found</p>
         <p className="text-[10px] mt-1 opacity-70">The selected window contains no saved parameters.</p>
      </div>
    );
  }

  const kpis = records.filter(r => r.category === 'kpi' && r.dataQuality === 'validated').slice(0, 4);
  const summaries = records.filter(r => r.category === 'summary' && r.dataQuality === 'validated' && typeof r.value === 'number');
  const devices = records.filter(r => r.category === 'device' && r.dataQuality === 'validated');
  const rawStatus = records.filter(r => r.dataQuality !== 'validated' || r.category === 'status' || r.category === 'raw');

  return (
    <div className="w-full flex flex-col gap-6" data-testid="saved-parameter-analytics">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 border-b border-scada-border relative">
        <span className="absolute bottom-0 left-0 h-px w-1/4 bg-gradient-to-r from-scada-accent to-transparent pointer-events-none" />
        <div>
          <h2 className="text-lg font-bold text-scada-text tracking-tight flex items-center gap-2">
            <Database size={18} className="text-scada-accent" />
            Saved Parameter Analytics
          </h2>
          <p className="text-xs text-scada-muted mt-1 font-medium">Saved backend records only. Raw and source-reported values remain evidence, not engineering KPIs.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedTimestamp && <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-scada-border bg-scada-surface-raised shadow-sm text-[10px] font-mono font-bold text-scada-text uppercase tracking-wider" data-testid="analytics-timestamp">
             <Clock size={12} className="text-scada-muted" />
             {new Date(selectedTimestamp).toLocaleString()}
          </div>}
          {onServerPageChange && totalRecords > serverPageSize && <div className="flex items-center gap-1 rounded-lg border border-scada-border bg-scada-surface-raised p-1" data-testid="saved-server-pagination">
            <button type="button" aria-label="Previous saved evidence page" disabled={serverPage <= 1} onClick={() => onServerPageChange(serverPage - 1)} className="rounded p-1 text-scada-muted hover:bg-scada-hover hover:text-scada-text focus-ring disabled:opacity-30"><ChevronLeft size={14} /></button>
            <span className="px-1 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Page {serverPage} · {totalRecords.toLocaleString()} saved</span>
            <button type="button" aria-label="Next saved evidence page" disabled={serverPage * serverPageSize >= totalRecords} onClick={() => onServerPageChange(serverPage + 1)} className="rounded p-1 text-scada-muted hover:bg-scada-hover hover:text-scada-text focus-ring disabled:opacity-30"><ChevronRight size={14} /></button>
          </div>}
        </div>
      </div>

      <KpiSection records={kpis} />
      <SummarySection records={summaries} />
      <DeviceSection records={devices} />
      <RawEvidenceSection records={rawStatus} />
      <DetailTableSection records={records} />
    </div>
  );
}
