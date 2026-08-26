import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, BarChart3, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Columns3, Cpu, Download, FileJson, FileSpreadsheet, FileText, Filter, History, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { buildReportQuery } from '../report-center-utils';
import {
  type ReportQuality as Quality,
  type ReportProvenance as Provenance,
  type ReportRecord,
  type ReportResult,
  formatDateTime,
  csvValue,
  buildPdfReportHtml,
  download,
  workbook,
} from '../report-export-utils';

type DatePreset = 'today' | 'yesterday' | 'last-7-days' | 'last-30-days' | 'current-month' | 'previous-month' | 'custom';
type Category = 'operations' | 'electrical' | 'energy' | 'inverter' | 'environmental' | 'alarms' | 'communication';
type Filters = {
  siteName: string;
  devices: string[];
  parameters: string[];
  category: Category[];
  status: 'all' | 'active' | 'warning' | 'normal';
  quality: 'all' | 'validated' | 'source-reported';
  preset: DatePreset;
  customFrom: string;
  customTo: string;
  customFromTime: string;
  customToTime: string;
};

const CATEGORIES: Array<{ value: Category; label: string }> = [
  { value: 'operations', label: 'Operations' },
  { value: 'electrical', label: 'Electrical' },
  { value: 'energy', label: 'Energy & yield' },
  { value: 'inverter', label: 'Inverter' },
  { value: 'environmental', label: 'Environmental' },
  { value: 'alarms', label: 'Alarms & faults' },
  { value: 'communication', label: 'Communication' },
];

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((item) => [item.value, item.label]));

type ColumnKey = 'sourceReported' | 'transportRaw' | 'device' | 'source' | 'observed' | 'received' | 'provenance' | 'quality' | 'status';
const OPTIONAL_COLUMNS: Array<{ key: ColumnKey; label: string; default: boolean }> = [
  { key: 'device', label: 'Device', default: true },
  { key: 'observed', label: 'Observed', default: true },
  { key: 'received', label: 'Received', default: false },
  { key: 'sourceReported', label: 'Source-reported value', default: false },
  { key: 'transportRaw', label: 'Transport raw', default: false },
  { key: 'source', label: 'Source', default: false },
  { key: 'provenance', label: 'Provenance', default: true },
  { key: 'quality', label: 'Quality', default: true },
  { key: 'status', label: 'Status', default: false },
];

const defaultFilters = (siteName: string): Filters => ({
  siteName,
  devices: [],
  parameters: [],
  category: [],
  status: 'all',
  quality: 'all',
  preset: 'last-7-days',
  customFrom: '',
  customTo: '',
  customFromTime: '',
  customToTime: '',
});

const EXPLORER_TABLE_PAGE_SIZE = 200;

function toggleSelection<T>(current: T[], value: T) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function filterCount(filters: Filters, initialSite: string) {
  return [
    filters.siteName !== initialSite,
    filters.devices.length > 0,
    filters.parameters.length > 0,
    filters.category.length > 0,
    filters.status !== 'all',
    filters.quality !== 'all',
    filters.preset !== 'last-7-days',
  ].filter(Boolean).length;
}

function tone(quality: Quality) {
  return quality === 'validated' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : quality === 'source-reported' ? 'border-blue-500/25 bg-blue-500/10 text-blue-400' : 'border-amber-500/25 bg-amber-500/10 text-amber-400';
}

function provenanceTone(provenance: Provenance) {
  return provenance === 'live' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : provenance === 'latest-saved' ? 'border-blue-500/25 bg-blue-500/10 text-blue-400' : 'border-slate-500/25 bg-slate-500/10 text-slate-400';
}

type SortKey = 'parameter' | 'value' | 'device' | 'observed' | 'quality';
type SortDirection = 'asc' | 'desc';

function recordSortValue(record: ReportRecord, key: SortKey): string | number {
  switch (key) {
    case 'value': return record.value ?? Number.NEGATIVE_INFINITY;
    case 'device': return (record.deviceName ?? record.deviceId ?? '').toLowerCase();
    case 'observed': return new Date(record.observedAt).getTime() || 0;
    case 'quality': return record.quality;
    default: return record.displayLabel.toLowerCase();
  }
}

export default function SavedDataExplorer({ siteName, sites, devices, parameters, onBack }: { siteName: string; sites: string[]; devices: Array<{ id: string; name: string; site: string; type: string }>; parameters: string[]; onBack: () => void }) {
  const [pending, setPending] = useState<Filters>(() => defaultFilters(siteName));
  const [applied, setApplied] = useState<Filters>(() => defaultFilters(siteName));
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [requestNotice, setRequestNotice] = useState('');
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | 'json' | 'pdf' | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [parameterSearch, setParameterSearch] = useState('');
  const [tableSearch, setTableSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('observed');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [columns, setColumns] = useState<Set<ColumnKey>>(() => new Set(OPTIONAL_COLUMNS.filter((column) => column.default).map((column) => column.key)));
  const reportRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPending((current) => current.siteName ? current : { ...current, siteName });
    setApplied((current) => current.siteName ? current : { ...current, siteName });
  }, [siteName]);

  const visibleDevices = useMemo(() => devices.filter((device) => !pending.siteName || device.site === pending.siteName), [devices, pending.siteName]);
  const filteredParameterChoices = useMemo(() => parameters.filter((parameter) => parameter.toLowerCase().includes(parameterSearch.trim().toLowerCase())), [parameters, parameterSearch]);
  const activeFilters = filterCount(applied, siteName);
  const toggleColumn = (key: ColumnKey) => setColumns((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const requestReport = async (filters: Filters, options: { page?: number; range?: { from: string; to: string } } = {}) => {
    if (reportRequestRef.current) {
      reportRequestRef.current.abort();
      setRequestNotice('Previous request cancelled; loading the latest selection.');
    } else {
      setRequestNotice('');
    }
    const controller = new AbortController();
    reportRequestRef.current = controller;
    setLoading(true);
    setError('');
    const page = options.page ?? 1;
    const query = buildReportQuery({ reportType: 'historical-saved', siteName: filters.siteName, devices: filters.devices, parameters: filters.parameters, status: filters.status, quality: filters.quality, provenance: [], preset: filters.preset, customFrom: filters.customFrom, customTo: filters.customTo, customFromTime: filters.customFromTime, customToTime: filters.customToTime, category: filters.category }, undefined, { page, pageSize: EXPLORER_TABLE_PAGE_SIZE, range: options.range });
    try {
      const response = await fetch(`/api/mqtt/reports?${query.toString()}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload = await response.json().catch(() => null) as ReportResult | { message?: string } | null;
      if (!response.ok || !payload || !('records' in payload)) throw new Error(payload && 'message' in payload ? payload.message ?? 'Unable to load saved data evidence.' : 'Unable to load saved data evidence.');
      setResult(payload);
      setApplied(filters);
      setTablePage(Math.max(0, (payload.pagination?.page ?? page) - 1));
      setRequestNotice('');
    } catch (requestError) {
      if (controller.signal.aborted || (requestError instanceof DOMException && requestError.name === 'AbortError')) return;
      setResult(null);
      setError(requestError instanceof Error ? requestError.message : 'Unable to load saved data evidence.');
      setRequestNotice('');
    } finally {
      if (reportRequestRef.current === controller) {
        reportRequestRef.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void requestReport(applied, { page: 1 });
    return () => reportRequestRef.current?.abort();
  }, []);

  const fetchCompleteReport = async () => {
    if (!result) throw new Error('Load the saved data preview before creating an export.');
    const query = buildReportQuery({ reportType: 'historical-saved', siteName: applied.siteName, devices: applied.devices, parameters: applied.parameters, status: applied.status, quality: applied.quality, provenance: [], preset: applied.preset, customFrom: applied.customFrom, customTo: applied.customTo, customFromTime: applied.customFromTime, customToTime: applied.customToTime, category: applied.category }, undefined, { complete: true, range: result.period });
    const response = await fetch(`/api/mqtt/reports?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => null) as ReportResult | { message?: string } | null;
    if (!response.ok || !payload || !('records' in payload) || payload.pagination?.complete !== true) {
      throw new Error(payload && 'message' in payload ? payload.message ?? 'Unable to retrieve the complete saved data evidence.' : 'Unable to retrieve the complete saved data evidence.');
    }
    return payload;
  };

  const runExport = async (format: 'csv' | 'xlsx' | 'json' | 'pdf', exporter: (completeResult: ReportResult) => void) => {
    if (!result || exporting) return;
    setExporting(format);
    setError('');
    try {
      const completeResult = await fetchCompleteReport();
      exporter(completeResult);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Unable to create the complete saved data export.');
    } finally {
      setExporting(null);
    }
  };

  const exportCsv = () => runExport('csv', (completeResult) => {
    const metadata = [['Report', completeResult.title], ['Site', completeResult.siteName], ['Period', completeResult.period.label], ['Generated', completeResult.generatedAt], ['Source status', completeResult.sourceStatus], ['Attribution', completeResult.attribution]];
    const headers = ['Category', 'Site', 'Device', 'Parameter', 'Validated value', 'Validated unit', 'Source-reported value', 'Source unit', 'Transport raw value', 'Source identity', 'Register address', 'Source', 'Observed', 'Received', 'Provenance', 'Quality', 'Status', 'Reason'];
    const lines = [...metadata.map((row) => row.map(csvValue).join(',')), '', headers.join(','), ...completeResult.records.map((record) => [record.category, record.siteName, record.deviceName ?? record.deviceId ?? '', record.displayLabel, record.value ?? '', record.unit, record.sourceReportedValue ?? '', record.sourceReportedUnit ?? '', record.transportRawValue ?? '', record.sourceIdentity ?? '', record.address, record.sourceName, record.observedAt, record.receivedAt, record.provenance, record.quality, record.status ?? '', record.reason ?? ''].map(csvValue).join(','))];
    download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `scada-saved-data-${completeResult.category}.csv`);
  });

  const exportJson = () => runExport('json', (completeResult) => download(new Blob([JSON.stringify(completeResult, null, 2)], { type: 'application/json' }), `scada-saved-data-${completeResult.category}.json`));
  const exportXlsx = () => runExport('xlsx', (completeResult) => download(new Blob([workbook(completeResult)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `scada-saved-data-${completeResult.category}.xlsx`));
  const exportPdf = () => {
    if (!result || exporting) return;
    const printWindow = window.open('', '_blank', 'width=1280,height=900');
    if (!printWindow) { setError('Your browser blocked the print window. Allow pop-ups to create the PDF.'); return; }
    printWindow.opener = null;
    printWindow.document.write('<!doctype html><title>Preparing saved data report…</title><body style="font:16px system-ui;padding:32px;color:#172033">Preparing the complete saved data export for print…</body>');
    printWindow.document.close();
    void runExport('pdf', (completeResult) => {
      printWindow.document.open();
      printWindow.document.write(buildPdfReportHtml(completeResult));
      printWindow.document.close();
      printWindow.focus();
    });
  };

  const reportRecords = result?.records ?? [];
  const searchedRecords = useMemo(() => {
    const needle = tableSearch.trim().toLowerCase();
    if (!needle) return reportRecords;
    return reportRecords.filter((record) => `${record.displayLabel} ${record.parameter} ${record.deviceName ?? ''} ${record.sourceName} ${record.address}`.toLowerCase().includes(needle));
  }, [reportRecords, tableSearch]);
  const sortedRecords = useMemo(() => [...searchedRecords].sort((a, b) => {
    const left = recordSortValue(a, sortKey);
    const right = recordSortValue(b, sortKey);
    const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
    return sortDirection === 'asc' ? comparison : -comparison;
  }), [searchedRecords, sortKey, sortDirection]);
  const pageServerInfo = result?.pagination;
  // Pagination walks the full server-side result set (pageServerInfo.totalPages), not just the
  // currently loaded 200-row page. Client-side search only narrows what's already loaded, so while
  // a search term is active we report a single page — searching across the rest of the archive
  // means clearing the search and paging normally.
  const tablePageCount = tableSearch ? 1 : Math.max(1, pageServerInfo?.totalPages ?? 1);
  const visibleTablePage = tableSearch ? 0 : Math.min(tablePage, tablePageCount - 1);
  const tableStart = (pageServerInfo?.page ? pageServerInfo.page - 1 : visibleTablePage) * EXPLORER_TABLE_PAGE_SIZE;
  const tableTotal = tableSearch ? sortedRecords.length : (pageServerInfo?.totalRecords ?? sortedRecords.length);
  const tableEnd = tableSearch ? sortedRecords.length : Math.min(tableStart + reportRecords.length, tableTotal);
  const visibleRecords = tableSearch ? sortedRecords : sortedRecords;
  const changeTablePage = (nextPage: number) => {
    if (loading || tableSearch || nextPage < 0 || nextPage >= tablePageCount) return;
    void requestReport(applied, { page: nextPage + 1, range: result ? { from: result.period.from, to: result.period.to } : undefined });
  };

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDirection(key === 'observed' ? 'desc' : 'asc'); }
  };
  const sortIndicator = (key: SortKey) => key === sortKey ? (sortDirection === 'asc' ? '↑' : '↓') : '↕';
  const sortHeaderButton = (key: SortKey, label: string) => (
    <button type="button" onClick={() => handleSort(key)} aria-label={`Sort by ${label}`} aria-sort={key === sortKey ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'} data-testid={`button-sort-saved-explorer-${key}`} className="inline-flex items-center gap-1 focus-ring">
      {label}<span aria-hidden="true" className={key === sortKey ? 'text-scada-accent' : 'text-scada-muted/50'}>{sortIndicator(key)}</span>
    </button>
  );

  const categoryGroups = useMemo(() => {
    const groups = new Map<string, ReportRecord[]>();
    for (const record of searchedRecords) {
      const list = groups.get(record.category) ?? [];
      list.push(record);
      groups.set(record.category, list);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [searchedRecords]);

  const deviceGroups = useMemo(() => {
    const groups = new Map<string, ReportRecord[]>();
    for (const record of searchedRecords) {
      const key = record.deviceName ?? record.deviceId;
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(record);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [searchedRecords]);

  return (
    <div data-testid="screen-saved-data-explorer" className="animate-rise-in space-y-5">
      <header className="scada-interactive-card rounded-2xl border border-scada-border bg-scada-surface p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <button type="button" onClick={onBack} data-testid="button-saved-data-back" className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-scada-muted hover:text-scada-text focus-ring"><ArrowLeft size={13} />Back to overview</button>
            <p className="text-[10px] font-bold uppercase tracking-[.18em] text-scada-accent">Saved Data / Detail view</p>
            <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight text-scada-text sm:text-3xl"><History size={22} className="text-scada-accent" />Saved data explorer</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-scada-muted">Investigate the full historical archive of validated saved backend records. Live telemetry is never shown here — use Live Data for current readings.</p>
          </div>
          <div className="rounded-xl border border-scada-border bg-scada-surface-raised px-3 py-2 text-right"><p className="text-[9px] font-bold uppercase tracking-wider text-scada-muted">Active filters</p><p data-testid="saved-data-active-filter-count" className="mt-1 text-xl font-bold text-scada-text">{activeFilters}</p></div>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-scada-border bg-scada-surface p-4 sm:p-5">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Filter size={16} className="text-scada-accent" /><h2 className="text-sm font-bold text-scada-text">Saved data filters</h2></div></div>
          <div className="mt-4 space-y-4">
            <label className="block"><span className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Plant / site</span><select value={pending.siteName} onChange={(event) => setPending({ ...pending, siteName: event.target.value, devices: [] })} data-testid="select-saved-explorer-site" className="mt-1.5 w-full rounded-lg border border-scada-border bg-scada-surface px-3 py-2 text-sm text-scada-text focus-ring"><option value="">All configured sites</option>{Array.from(new Set([siteName, ...sites])).filter(Boolean).map((site) => <option key={site} value={site}>{site}</option>)}</select></label>
            <fieldset><legend className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Inverters / devices</legend><div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-scada-border bg-scada-surface p-2 scrollbar-thin">{visibleDevices.filter((device) => device.type === 'Power inverter').length ? visibleDevices.filter((device) => device.type === 'Power inverter').map((device) => <label key={device.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-scada-text hover:bg-scada-hover"><input type="checkbox" checked={pending.devices.includes(device.id)} onChange={() => setPending({ ...pending, devices: toggleSelection(pending.devices, device.id) })} />{device.name}</label>) : <p className="px-1 py-1 text-xs text-scada-muted">No inverters available for this site.</p>}</div></fieldset>
            <fieldset><legend className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Parameter search</legend>
              <div className="relative mt-1.5"><Search size={13} className="absolute left-2.5 top-2.5 text-scada-muted" /><input value={parameterSearch} onChange={(event) => setParameterSearch(event.target.value)} placeholder="Find a parameter…" data-testid="input-saved-explorer-parameter-search" className="w-full rounded-lg border border-scada-border bg-scada-surface py-2 pl-8 pr-2 text-xs text-scada-text placeholder:text-scada-muted focus-ring" /></div>
              <div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-scada-border bg-scada-surface p-2 scrollbar-thin">{filteredParameterChoices.slice(0, 60).length ? filteredParameterChoices.slice(0, 60).map((parameter) => <label key={parameter} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-scada-text hover:bg-scada-hover"><input type="checkbox" checked={pending.parameters.includes(parameter)} onChange={() => setPending({ ...pending, parameters: toggleSelection(pending.parameters, parameter) })} /><span className="truncate">{parameter}</span></label>) : <p className="px-1 py-1 text-xs text-scada-muted">No parameter choices match.</p>}</div>
            </fieldset>
            <fieldset><legend className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Category</legend><div className="mt-1.5 grid grid-cols-1 gap-1">{CATEGORIES.map((category) => <label key={category.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-scada-text hover:bg-scada-hover"><input type="checkbox" checked={pending.category.includes(category.value)} onChange={() => setPending({ ...pending, category: toggleSelection(pending.category, category.value) })} />{category.label}</label>)}</div></fieldset>
            <div className="grid grid-cols-2 gap-3"><label><span className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Status</span><select value={pending.status} onChange={(event) => setPending({ ...pending, status: event.target.value as Filters['status'] })} className="mt-1.5 w-full rounded-lg border border-scada-border bg-scada-surface px-2 py-2 text-xs text-scada-text focus-ring"><option value="all">All</option><option value="active">Source active</option><option value="warning">Warning</option><option value="normal">Normal</option></select></label><label><span className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Data quality</span><select value={pending.quality} onChange={(event) => setPending({ ...pending, quality: event.target.value as Filters['quality'] })} className="mt-1.5 w-full rounded-lg border border-scada-border bg-scada-surface px-2 py-2 text-xs text-scada-text focus-ring"><option value="all">Included values</option><option value="validated">Validated only</option><option value="source-reported">Events only</option></select></label></div>
            <label className="block"><span className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Date &amp; time range</span><select data-testid="select-saved-explorer-range" value={pending.preset} onChange={(event) => setPending({ ...pending, preset: event.target.value as DatePreset })} className="mt-1.5 w-full rounded-lg border border-scada-border bg-scada-surface px-3 py-2 text-sm text-scada-text focus-ring"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="last-7-days">Last 7 days</option><option value="last-30-days">Last 30 days</option><option value="current-month">Current month</option><option value="previous-month">Previous month</option><option value="custom">Custom date &amp; time</option></select></label>
            {pending.preset === 'custom' && <div className="grid grid-cols-2 gap-2"><label><span className="text-[10px] text-scada-muted">From date</span><input type="date" value={pending.customFrom} onChange={(event) => setPending({ ...pending, customFrom: event.target.value })} className="mt-1 w-full rounded-lg border border-scada-border bg-scada-surface px-2 py-2 text-xs text-scada-text focus-ring" /></label><label><span className="text-[10px] text-scada-muted">From time</span><input type="time" value={pending.customFromTime} onChange={(event) => setPending({ ...pending, customFromTime: event.target.value })} className="mt-1 w-full rounded-lg border border-scada-border bg-scada-surface px-2 py-2 text-xs text-scada-text focus-ring" /></label><label><span className="text-[10px] text-scada-muted">To date</span><input type="date" value={pending.customTo} onChange={(event) => setPending({ ...pending, customTo: event.target.value })} className="mt-1 w-full rounded-lg border border-scada-border bg-scada-surface px-2 py-2 text-xs text-scada-text focus-ring" /></label><label><span className="text-[10px] text-scada-muted">To time</span><input type="time" value={pending.customToTime} onChange={(event) => setPending({ ...pending, customToTime: event.target.value })} className="mt-1 w-full rounded-lg border border-scada-border bg-scada-surface px-2 py-2 text-xs text-scada-text focus-ring" /></label></div>}
            <div className="grid grid-cols-2 gap-2 border-t border-scada-border pt-4"><button type="button" data-testid="button-apply-saved-explorer" onClick={() => void requestReport(pending)} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-lg bg-scada-accent px-3 py-2.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-60 focus-ring">{loading ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}{loading ? 'Loading' : 'Apply'}</button><button type="button" onClick={() => { const reset = defaultFilters(siteName); setPending(reset); void requestReport(reset); }} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-lg border border-scada-border bg-scada-surface px-3 py-2.5 text-xs font-semibold text-scada-text hover:bg-scada-hover disabled:opacity-60 focus-ring"><RotateCcw size={14} />Reset</button></div>
          </div>
        </aside>

        <section className="min-w-0 space-y-5">
          {(loading || requestNotice || exporting) && <div role="status" data-testid="saved-explorer-request-status" className="flex items-center justify-center gap-2 rounded-xl border border-scada-border bg-scada-surface-raised px-4 py-3 text-xs text-scada-muted"><RefreshCw size={14} className={loading || exporting ? 'animate-spin text-scada-accent' : 'text-scada-accent'} />{exporting ? `Retrieving complete evidence for ${exporting.toUpperCase()} export…` : loading ? 'Loading saved backend evidence…' : requestNotice}</div>}
          {!loading && error && <div role="alert" className="rounded-2xl border border-rose-500/25 bg-rose-500/[.06] p-5 text-sm text-rose-300"><AlertTriangle size={17} className="mr-2 inline text-rose-400" />{error}<button type="button" onClick={() => void requestReport(applied)} className="ml-3 font-semibold text-rose-300 underline focus-ring">Try again</button></div>}
          {!error && result && <>
            <div className="rounded-2xl border border-scada-border bg-scada-surface p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div><div className="flex flex-wrap items-center gap-2"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-scada-accent">Preview ready</p><span className="rounded-full border border-scada-border bg-scada-surface-raised px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Saved evidence only</span></div><h2 className="mt-2 text-xl font-bold text-scada-text">{result.title}</h2><p className="mt-1 text-sm text-scada-muted">{result.siteName} <span className="px-1 text-scada-muted/60">•</span> {result.period.label}</p><p className="mt-2 text-[11px] text-scada-muted">{result.sourceStatus}</p></div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={exportCsv} data-testid="button-saved-explorer-export-csv" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/20 focus-ring"><Download size={14} />CSV</button>
                  <button type="button" onClick={exportXlsx} data-testid="button-saved-explorer-export-xlsx" className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-400 hover:bg-blue-500/20 focus-ring"><FileSpreadsheet size={14} />Excel</button>
                  <button type="button" onClick={exportJson} data-testid="button-saved-explorer-export-json" className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs font-bold text-violet-400 hover:bg-violet-500/20 focus-ring"><FileJson size={14} />JSON</button>
                  <button type="button" onClick={exportPdf} data-testid="button-saved-explorer-export-pdf" className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-400 hover:bg-rose-500/20 focus-ring"><FileText size={14} />PDF</button>
                  <button type="button" onClick={() => void requestReport(applied)} aria-label="Refresh saved data preview" className="inline-flex items-center justify-center rounded-lg border border-scada-border bg-scada-surface px-3 py-2 text-scada-text hover:bg-scada-hover focus-ring"><RefreshCw size={14} /></button>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-scada-border pt-3 text-[10px] text-scada-muted"><span><strong className="text-scada-text">Generated:</strong> {formatDateTime(result.generatedAt)}</span><span><strong className="text-scada-text">Latest observed:</strong> {result.freshness.latestObservedAt ? formatDateTime(result.freshness.latestObservedAt) : 'No included evidence'}</span><span><strong className="text-scada-text">Filters:</strong> {activeFilters ? `${activeFilters} active` : 'Default scope'}</span><span><strong className="text-scada-text">Attribution:</strong> {result.attribution}</span></div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">{result.summary.map((item) => <article key={item.label} className="scada-interactive-card rounded-xl border border-scada-border bg-scada-surface p-4"><div className="flex items-start justify-between gap-2"><p className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">{item.label}</p><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone(item.quality)}`}>{item.quality.replace('-', ' ')}</span></div><p className="mt-3 text-2xl font-bold text-scada-text">{Number(item.value).toLocaleString()} <span className="text-sm text-scada-muted">{item.unit}</span></p><p className="mt-2 text-[11px] leading-4 text-scada-muted">{item.detail}</p></article>)}</div>

            {result.charts.length > 0 && result.charts.slice(0, 1).map((chart) => <section key={chart.title} className="rounded-2xl border border-scada-border bg-scada-surface p-4 sm:p-5"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Trend</p><h3 className="mt-1 text-sm font-bold text-scada-text">{chart.title}</h3></div><BarChart3 size={18} className="text-scada-accent" /></div><div className="mt-4 h-56"><ResponsiveContainer width="100%" height="100%">{chart.kind === 'bar' ? <BarChart data={chart.data}><CartesianGrid strokeDasharray="3 3" stroke="var(--scada-border)" vertical={false} /><XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip contentStyle={{ background: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: 10 }} formatter={(value) => [`${Number(value).toLocaleString()} ${chart.unit}`, 'Validated value']} /><Bar dataKey="value" fill="var(--scada-accent)" radius={[4, 4, 0, 0]} /></BarChart> : <LineChart data={chart.data}><CartesianGrid strokeDasharray="3 3" stroke="var(--scada-border)" vertical={false} /><XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} minTickGap={20} /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip contentStyle={{ background: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: 10 }} formatter={(value) => [`${Number(value).toLocaleString()} ${chart.unit}`, 'Validated value']} /><Line type="monotone" dataKey="value" stroke="var(--scada-accent)" strokeWidth={2} dot={false} /></LineChart>}</ResponsiveContainer></div></section>)}

            {deviceGroups.length > 1 && <section className="rounded-2xl border border-scada-border bg-scada-surface p-4 sm:p-5" data-testid="section-saved-explorer-device-comparison">
              <div className="flex items-center gap-2"><Cpu size={16} className="text-scada-accent" /><h3 className="text-sm font-bold text-scada-text">Device / inverter comparison</h3></div>
              <p className="mt-1 text-[11px] text-scada-muted">Latest saved value per parameter for each device in the current selection.</p>
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {deviceGroups.map(([device, items]) => {
                  const latestByParameter = new Map<string, ReportRecord>();
                  for (const item of items) {
                    const existing = latestByParameter.get(item.displayLabel);
                    if (!existing || new Date(item.observedAt).getTime() > new Date(existing.observedAt).getTime()) latestByParameter.set(item.displayLabel, item);
                  }
                  const shown = [...latestByParameter.values()].slice(0, 6);
                  return (
                    <div key={device} className="rounded-xl border border-scada-border bg-scada-surface-raised p-3" data-testid={`saved-explorer-device-card-${device}`}>
                      <div className="flex items-center justify-between gap-2"><h4 className="truncate text-xs font-bold text-scada-text">{device}</h4><span className="rounded-full border border-scada-border bg-scada-surface px-2 py-0.5 text-[9px] font-bold text-scada-muted">{items.length} rows</span></div>
                      <div className="mt-2 space-y-1.5">{shown.map((item) => <div key={item.id} className="flex items-center justify-between gap-2 border-b border-scada-border/40 pb-1 text-[11px] last:border-0 last:pb-0"><span className="truncate text-scada-muted">{item.displayLabel}</span><span className="whitespace-nowrap font-mono font-bold text-scada-text">{item.value === null ? '—' : item.value.toLocaleString()} <span className="text-[9px] font-normal text-scada-muted">{item.unit}</span></span></div>)}</div>
                    </div>
                  );
                })}
              </div>
            </section>}

            {categoryGroups.length > 0 && <section className="space-y-3" data-testid="section-saved-explorer-category-groups">
              {categoryGroups.map(([category, items]) => (
                <details key={category} className="group rounded-2xl border border-scada-border bg-scada-surface" data-testid={`saved-explorer-category-${category}`}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-bold text-scada-text focus-ring"><span>{CATEGORY_LABEL[category] ?? category} <span className="ml-2 rounded-full border border-scada-border bg-scada-surface-raised px-2 py-0.5 text-[10px] font-bold text-scada-muted">{items.length}</span></span><ChevronDown size={16} className="text-scada-muted transition-transform group-open:rotate-180" /></summary>
                  <div className="max-w-full overflow-x-auto scrollbar-thin border-t border-scada-border">
                    <table className="w-full min-w-[720px] text-left">
                      <thead className="bg-scada-surface-raised"><tr>{['Parameter', 'Value', 'Device', 'Observed', 'Quality'].map((heading) => <th key={heading} className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-scada-muted">{heading}</th>)}</tr></thead>
                      <tbody className="divide-y divide-scada-border">{items.slice(0, 50).map((record) => <tr key={record.id} className="hover:bg-scada-hover/40"><td className="px-4 py-2.5 text-xs font-semibold text-scada-text">{record.displayLabel}</td><td className="px-4 py-2.5 text-xs font-mono font-bold text-scada-text">{record.value === null ? '—' : `${record.value.toLocaleString()} ${record.unit}`}</td><td className="px-4 py-2.5 text-xs text-scada-muted">{record.deviceName ?? record.deviceId ?? 'Plant context'}</td><td className="px-4 py-2.5 text-[11px] text-scada-muted">{formatDateTime(record.observedAt)}</td><td className="px-4 py-2.5"><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone(record.quality)}`}>{record.quality.replace('-', ' ')}</span></td></tr>)}</tbody>
                    </table>
                    {items.length > 50 && <p className="px-4 py-2 text-[10px] text-scada-muted">Showing 50 of {items.length}. See the full detail table below for the complete set.</p>}
                  </div>
                </details>
              ))}
            </section>}

            <section className="rounded-2xl border border-scada-border bg-scada-surface">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-scada-border p-4 sm:p-5">
                <div><p className="text-[10px] font-bold uppercase tracking-wider text-scada-muted">Detailed evidence</p><h3 className="mt-1 text-sm font-bold text-scada-text">Validated and source-reported saved records</h3><p className="mt-1 text-[11px] text-scada-muted">Search and sort within the loaded page; exports always cover the full selected period.</p></div>
                <span className="rounded-full border border-scada-border bg-scada-surface-raised px-2.5 py-1 text-[10px] font-bold text-scada-muted">{reportRecords.length.toLocaleString()} rows loaded</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-b border-scada-border px-4 py-3 sm:px-5">
                <div className="relative min-w-[200px] flex-1"><Search size={13} className="absolute left-2.5 top-2.5 text-scada-muted" /><input value={tableSearch} onChange={(event) => setTableSearch(event.target.value)} placeholder="Search this loaded page…" data-testid="input-saved-explorer-table-search" className="w-full rounded-lg border border-scada-border bg-scada-surface py-2 pl-8 pr-2 text-xs text-scada-text placeholder:text-scada-muted focus-ring" /></div>
                <div className="relative">
                  <button type="button" onClick={() => setColumnMenuOpen((open) => !open)} data-testid="button-saved-explorer-columns" className="inline-flex items-center gap-1.5 rounded-lg border border-scada-border bg-scada-surface px-3 py-2 text-xs font-semibold text-scada-text hover:bg-scada-hover focus-ring"><Columns3 size={14} />Columns</button>
                  {columnMenuOpen && <div className="absolute right-0 z-10 mt-1 w-52 rounded-lg border border-scada-border bg-scada-surface p-2 shadow-lg">{OPTIONAL_COLUMNS.map((column) => <label key={column.key} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-scada-text hover:bg-scada-hover"><input type="checkbox" checked={columns.has(column.key)} onChange={() => toggleColumn(column.key)} />{column.label}</label>)}</div>}
                </div>
              </div>
              {tablePageCount > 1 && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-scada-border px-4 py-3 text-xs text-scada-muted sm:px-5"><p>Viewing <strong className="text-scada-text">{(tableStart + 1).toLocaleString()}–{tableEnd.toLocaleString()}</strong> of {tableTotal.toLocaleString()} records.</p><div className="flex items-center gap-2"><button type="button" aria-label="Previous saved evidence page" disabled={loading || visibleTablePage === 0} onClick={() => changeTablePage(visibleTablePage - 1)} className="inline-flex items-center rounded-md border border-scada-border bg-scada-surface p-1.5 text-scada-text hover:bg-scada-hover disabled:cursor-not-allowed disabled:opacity-40 focus-ring"><ChevronLeft size={15} /></button><span className="font-mono text-[11px] text-scada-muted">{visibleTablePage + 1} / {tablePageCount}</span><button type="button" aria-label="Next saved evidence page" disabled={loading || visibleTablePage >= tablePageCount - 1} onClick={() => changeTablePage(visibleTablePage + 1)} className="inline-flex items-center rounded-md border border-scada-border bg-scada-surface p-1.5 text-scada-text hover:bg-scada-hover disabled:cursor-not-allowed disabled:opacity-40 focus-ring"><ChevronRight size={15} /></button></div></div>}
              <div className="max-w-full overflow-x-auto scrollbar-thin" data-scroll-region="saved-explorer-records">
                <table className="w-full min-w-[1080px] text-left">
                  <thead className="bg-scada-surface-raised">
                    <tr>
                      <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">{sortHeaderButton('parameter', 'Parameter')}</th>
                      <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">{sortHeaderButton('value', 'Validated value')}</th>
                      {columns.has('sourceReported') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Source-reported value</th>}
                      {columns.has('transportRaw') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Transport raw</th>}
                      {columns.has('device') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">{sortHeaderButton('device', 'Device')}</th>}
                      {columns.has('source') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Source</th>}
                      {columns.has('observed') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">{sortHeaderButton('observed', 'Observed')}</th>}
                      {columns.has('received') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Received</th>}
                      {columns.has('provenance') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Provenance</th>}
                      {columns.has('quality') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">{sortHeaderButton('quality', 'Quality')}</th>}
                      {columns.has('status') && <th className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-scada-muted">Status</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-scada-border">
                    {visibleRecords.length ? visibleRecords.map((record) => (
                      <tr key={record.id} data-testid={`row-saved-explorer-${record.id}`} className="hover:bg-scada-hover/40">
                        <td className="px-4 py-3"><p className="text-xs font-semibold text-scada-text">{record.displayLabel}</p><p className="mt-0.5 font-mono text-[10px] text-scada-muted">{record.address}{record.sourceIdentity ? ` · ${record.sourceIdentity}` : ''}</p></td>
                        <td className="px-4 py-3 text-xs font-mono font-bold text-scada-text">{record.value === null ? '—' : `${record.value.toLocaleString()} ${record.unit}`}</td>
                        {columns.has('sourceReported') && <td className="px-4 py-3 text-xs font-mono text-scada-accent">{record.sourceReportedValue ? `${record.sourceReportedValue} ${record.sourceReportedUnit ?? 'Raw / not declared'}` : '—'}</td>}
                        {columns.has('transportRaw') && <td className="px-4 py-3 text-xs font-mono text-scada-muted">{record.transportRawValue ?? '—'}</td>}
                        {columns.has('device') && <td className="px-4 py-3 text-xs text-scada-text">{record.deviceName ?? record.deviceId ?? 'Plant context'}</td>}
                        {columns.has('source') && <td className="px-4 py-3 text-xs text-scada-text">{record.sourceName}</td>}
                        {columns.has('observed') && <td className="px-4 py-3 text-[11px] text-scada-muted">{formatDateTime(record.observedAt)}</td>}
                        {columns.has('received') && <td className="px-4 py-3 text-[11px] text-scada-muted">{formatDateTime(record.receivedAt)}</td>}
                        {columns.has('provenance') && <td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${provenanceTone(record.provenance)}`}>{record.provenance.replace('-', ' ')}</span></td>}
                        {columns.has('quality') && <td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone(record.quality)}`}>{record.quality.replace('-', ' ')}</span></td>}
                        {columns.has('status') && <td className="px-4 py-3 text-xs text-scada-muted">{record.status ?? record.reason ?? '—'}</td>}
                      </tr>
                    )) : <tr><td colSpan={11} className="px-5 py-12 text-center text-sm text-scada-muted">No saved records match the selected filters{tableSearch ? ' and search text' : ''}. Widen the date range or clear filters to see more evidence.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            {result.excludedEvidence.count > 0 && <details className="rounded-2xl border border-amber-500/20 bg-amber-500/[.04] p-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold text-amber-400 focus-ring"><span>Why some evidence is excluded</span><ChevronDown size={16} /></summary><p className="mt-3 text-xs leading-5 text-amber-300/80">This explorer never estimates engineering values from raw registers. The following evidence was retained only as an audit explanation:</p><ul className="mt-3 space-y-2">{result.excludedEvidence.byReason.map((item) => <li key={item.reason} className="flex justify-between gap-3 rounded-lg border border-amber-500/15 bg-scada-surface/40 px-3 py-2 text-xs"><span className="text-scada-text">{item.reason}</span><span className="shrink-0 font-mono text-amber-400">{item.count}</span></li>)}</ul></details>}
            <footer className="rounded-xl border border-scada-border bg-scada-surface px-4 py-3 text-center text-[10px] font-semibold tracking-wide text-scada-muted">{result.qualityNotes.map((note) => <p key={note} className="mb-1 last:mb-0">{note}</p>)}<p className="mt-2 text-scada-muted">{result.attribution}</p></footer>
          </>}
          {!error && !result && !loading && <div className="rounded-2xl border border-dashed border-scada-border bg-scada-surface p-10 text-center text-sm text-scada-muted">No saved data preview loaded yet.</div>}
        </section>
      </div>
    </div>
  );
}
