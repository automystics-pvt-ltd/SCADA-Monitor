import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, FileJson, FileSpreadsheet, FileText, Filter, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { buildReportQuery } from '../report-center-utils';

type ReportType = 'operations' | 'electrical' | 'energy' | 'inverter' | 'environmental' | 'alarms' | 'communication' | 'live' | 'historical' | 'comparison' | 'availability' | 'data-quality' | 'plant-monitoring' | 'inverter-monitoring' | 'electrical-parameters' | 'ac-dc-power' | 'energy-generation' | 'mppt-monitoring' | 'string-monitoring' | 'temperature-monitoring' | 'power-factor-frequency' | 'alarm-fault' | 'device-communication' | 'mqtt-modbus-telemetry' | 'live-data' | 'historical-saved';
type DatePreset = 'today' | 'yesterday' | 'last-7-days' | 'last-30-days' | 'current-month' | 'previous-month' | 'custom';
type Provenance = 'live' | 'latest-saved' | 'historical-saved';
type Quality = 'validated' | 'source-reported' | 'raw';

type ReportRecord = {
  id: string;
  recordType: 'measurement' | 'energy' | 'snapshot' | 'alarm' | 'communication';
  category: string;
  siteName: string;
  deviceId: string | null;
  deviceName: string | null;
  parameter: string;
  displayLabel: string;
  value: number | null;
  unit: string;
  address: string;
  sourceName: string;
  observedAt: string;
  receivedAt: string;
  provenance: Provenance;
  quality: Quality;
  status: string | null;
  reason: string | null;
  sourceReportedValue?: string | null;
  sourceReportedUnit?: string | null;
  transportRawValue?: string | null;
  sourceIdentity?: string | null;
};

type ReportResult = {
  title: string;
  category: ReportType;
  siteName: string;
  period: { from: string; to: string; label: string };
  generatedAt: string;
  sourceStatus: string;
  freshness: { latestObservedAt: string | null; latestReceivedAt: string | null };
  filters: Record<string, unknown>;
  summary: Array<{ label: string; value: number | string; unit: string; detail: string; quality: Quality }>;
  charts: Array<{ kind: 'line' | 'area' | 'bar'; title: string; unit: string; data: Array<{ time: string; value: number; label: string }> }>;
  records: ReportRecord[];
  excludedEvidence: { count: number; byReason: Array<{ reason: string; count: number }> };
  alarmSummary: { reported: number; sourceReported: number; active: number };
  communicationSummary: { events: number; warnings: number };
  qualityNotes: string[];
  attribution: string;
  pagination: {
    page: number;
    pageSize: number;
    totalRecords: number;
    totalPages: number;
    complete: boolean;
  };
};

type Filters = {
  reportType: ReportType;
  siteName: string;
  devices: string[];
  parameters: string[];
  status: 'all' | 'active' | 'warning' | 'normal';
  quality: 'all' | 'validated' | 'source-reported';
  provenance: Provenance[];
  preset: DatePreset;
  customFrom: string;
  customTo: string;
  customFromTime: string;
  customToTime: string;
};

const REPORT_TYPES: Array<{ value: ReportType; label: string; description: string }> = [
  { value: 'operations', label: 'Operations overview', description: 'Validated operating evidence, alarms, and communication context.' },
  { value: 'electrical', label: 'Electrical performance', description: 'Validated electrical measurements and source trends.' },
  { value: 'energy', label: 'Energy & yield', description: 'Saved energy counters and source-backed yield evidence.' },
  { value: 'inverter', label: 'Inverter detail', description: 'Device-specific validated measurements and energy history.' },
  { value: 'environmental', label: 'Environmental', description: 'Source-reported environmental operating context.' },
  { value: 'alarms', label: 'Alarms & faults', description: 'Source-reported alarm evidence with no invented diagnosis.' },
  { value: 'communication', label: 'Communication', description: 'Durable MQTT delivery and interruption evidence.' },
  { value: 'live', label: 'Live snapshot', description: 'Currently available, explicitly validated live evidence only.' },
  { value: 'historical', label: 'Historical review', description: 'Saved source evidence across the selected reporting period.' },
  { value: 'comparison', label: 'Site comparison', description: 'Comparable validated inverter and energy records.' },
  { value: 'availability', label: 'Availability', description: 'Communication and operational evidence; no inferred uptime.' },
  { value: 'data-quality', label: 'Data quality', description: 'Included validated records and excluded raw evidence.' },
  { value: 'plant-monitoring', label: 'Plant / site monitoring', description: 'All included source-backed operational evidence for the selected plant or site.' },
  { value: 'inverter-monitoring', label: 'Inverter monitoring', description: 'Device-attributed inverter measurements, energy, alarms, and communication context.' },
  { value: 'electrical-parameters', label: 'Electrical parameters', description: 'Validated voltage, current, reactive, and other electrical parameter records.' },
  { value: 'ac-dc-power', label: 'AC / DC power', description: 'Validated AC and DC power records kept separate from other parameters.' },
  { value: 'energy-generation', label: 'Energy generation', description: 'Validated source-backed energy and generation records.' },
  { value: 'mppt-monitoring', label: 'MPPT monitoring', description: 'Validated maximum-power-point tracker and MPPT input records when reported.' },
  { value: 'string-monitoring', label: 'String monitoring', description: 'Validated PV string and string-input records when reported.' },
  { value: 'temperature-monitoring', label: 'Temperature monitoring', description: 'Validated equipment, cabinet, heatsink, and reported temperature records.' },
  { value: 'power-factor-frequency', label: 'Power factor & frequency', description: 'Validated power-factor and frequency records with their reported units.' },
  { value: 'alarm-fault', label: 'Alarm & fault report', description: 'Source-reported alarm and fault evidence, without invented diagnosis.' },
  { value: 'device-communication', label: 'Device communication', description: 'Source-reported delivery and communication events for the selected period.' },
  { value: 'mqtt-modbus-telemetry', label: 'MQTT / Modbus telemetry', description: 'Source-backed telemetry records with addresses, sources, timestamps, and quality.' },
  { value: 'live-data', label: 'Live data', description: 'Currently available evidence explicitly identified as live.' },
  { value: 'historical-saved', label: 'Historical saved data', description: 'Latest-saved and historical-saved evidence across the selected period.' },
];

const defaultFilters = (siteName: string): Filters => ({
  reportType: 'operations',
  siteName,
  devices: [],
  parameters: [],
  status: 'all',
  quality: 'all',
  provenance: [],
  preset: 'last-7-days',
  customFrom: '',
  customTo: '',
  customFromTime: '',
  customToTime: '',
});
const REPORT_TABLE_PAGE_SIZE = 200;

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not reported' : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(date);
}

function csvValue(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function xml(value: unknown) {
  return String(value ?? '').replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] ?? character));
}

function html(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

function reportQualityClass(quality: Quality) {
  return quality === 'validated' ? 'quality-validated' : quality === 'source-reported' ? 'quality-source' : 'quality-raw';
}

function reportProvenanceClass(provenance: Provenance) {
  return provenance === 'live' ? 'provenance-live' : provenance === 'latest-saved' ? 'provenance-latest' : 'provenance-history';
}

function reportChartSvg(chart: ReportResult['charts'][number]) {
  const width = 720;
  const height = 190;
  const left = 46;
  const right = 18;
  const top = 18;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = chart.data.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum || Math.max(Math.abs(maximum) * 0.12, 1);
  const yMin = minimum - spread * 0.08;
  const yMax = maximum + spread * 0.08;
  const x = (index: number) => left + (chart.data.length <= 1 ? plotWidth / 2 : index * plotWidth / (chart.data.length - 1));
  const y = (value: number) => top + (yMax - value) * plotHeight / (yMax - yMin);
  const points = chart.data.map((point, index) => `${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const first = chart.data[0];
  const last = chart.data[chart.data.length - 1];
  const yLabels = [yMax, (yMax + yMin) / 2, yMin].map((value) => `<text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${html(value.toLocaleString(undefined, { maximumFractionDigits: 1 }))}</text>`).join('');
  return `<svg class="report-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${html(chart.title)}"><g class="chart-grid"><line x1="${left}" x2="${width - right}" y1="${y(yMax)}" y2="${y(yMax)}"/><line x1="${left}" x2="${width - right}" y1="${y((yMax + yMin) / 2)}" y2="${y((yMax + yMin) / 2)}"/><line x1="${left}" x2="${width - right}" y1="${y(yMin)}" y2="${y(yMin)}"/></g><g class="chart-labels">${yLabels}<text x="${left}" y="${height - 6}">${html(first ? formatDateTime(first.time) : '')}</text><text x="${width - right}" y="${height - 6}" text-anchor="end">${html(last ? formatDateTime(last.time) : '')}</text></g><polyline class="chart-line" points="${points}"/><circle class="chart-dot" cx="${x(chart.data.length - 1)}" cy="${y(chart.data.at(-1)?.value ?? 0)}" r="4"/></svg>`;
}

function buildPdfReportHtml(result: ReportResult) {
  const summary = result.summary.map((item) => `<article class="metric-card"><p class="metric-label">${html(item.label)}</p><p class="metric-value">${html(Number(item.value).toLocaleString())} <span>${html(item.unit)}</span></p><p class="metric-detail">${html(item.detail)}</p><span class="quality-pill ${reportQualityClass(item.quality)}">${html(item.quality.replace('-', ' '))}</span></article>`).join('');
  const charts = result.charts.length
    ? result.charts.slice(0, 4).map((chart) => `<section class="chart-card"><div class="chart-heading"><div><p class="section-kicker">Validated trend</p><h3>${html(chart.title)}</h3></div><span class="chart-unit">${html(chart.unit)}</span></div>${reportChartSvg(chart)}</section>`).join('')
    : `<section class="empty-card"><p class="section-kicker">Trend view</p><h3>No eligible numeric trend in this selection</h3><p>Only explicitly validated values are charted. Raw and source-reported evidence remains available in the table.</p></section>`;
  const exclusions = result.excludedEvidence.count
    ? `<section class="audit-card"><div><p class="section-kicker">Audit note</p><h3>${html(result.excludedEvidence.count.toLocaleString())} evidence item${result.excludedEvidence.count === 1 ? '' : 's'} excluded from report values</h3><p>Raw or unvalidated evidence is retained as an audit explanation and is never converted into customer-facing engineering values.</p></div><ul>${result.excludedEvidence.byReason.map((item) => `<li><span>${html(item.reason)}</span><strong>${html(item.count.toLocaleString())}</strong></li>`).join('')}</ul></section>`
    : '';
  const rows = result.records.map((record) => `<tr><td><strong>${html(record.displayLabel)}</strong><small>${html(record.parameter)} · ${html(record.address)}${record.sourceIdentity ? ` · ${html(record.sourceIdentity)}` : ''}</small></td><td class="value-cell">${record.value === null ? '—' : `${html(record.value.toLocaleString())}<small>${html(record.unit)}</small>`}</td><td class="source-cell">${record.sourceReportedValue ? `${html(record.sourceReportedValue)}<small>${html(record.sourceReportedUnit ?? 'Unit not declared')}</small>` : '—'}</td><td>${html(record.deviceName ?? record.deviceId ?? 'Plant context')}</td><td>${html(record.sourceName)}<small>${html(formatDateTime(record.observedAt))}</small></td><td><span class="quality-pill ${reportProvenanceClass(record.provenance)}">${html(record.provenance.replaceAll('-', ' '))}</span><span class="quality-pill ${reportQualityClass(record.quality)}">${html(record.quality.replace('-', ' '))}</span></td></tr>`).join('');
  const emptyRows = `<tr><td colspan="6" class="empty-table">No included source records match the selected filters.</td></tr>`;
  const notes = result.qualityNotes.map((note) => `<li>${html(note)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(result.title)} · ${html(result.siteName)}</title><style>
    :root{color-scheme:light;--ink:#172033;--muted:#64748b;--line:#dbe4ef;--soft:#f5f8fc;--blue:#155eef;--blue-soft:#eaf1ff;--green:#087443;--green-soft:#eaf8f1;--amber:#9a6700;--amber-soft:#fff8e6}
    *{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:10px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:34px 40px 46px}.cover{position:relative;overflow:hidden;padding:30px 32px 28px;border-radius:18px;background:linear-gradient(130deg,#102d63 0%,#155eef 58%,#159a92 140%);color:#fff}.cover:after{content:"";position:absolute;width:260px;height:260px;right:-90px;top:-130px;border:1px solid rgba(255,255,255,.2);border-radius:50%;box-shadow:0 0 0 28px rgba(255,255,255,.05),0 0 0 56px rgba(255,255,255,.04)}.brand{position:relative;z-index:1;display:flex;align-items:center;gap:8px;font-size:9px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;opacity:.86}.brand-mark{display:grid;place-items:center;width:22px;height:22px;border:1px solid rgba(255,255,255,.45);border-radius:7px;font-size:14px}.eyebrow,.section-kicker{font-size:8px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.eyebrow{position:relative;z-index:1;margin:30px 0 8px;color:#bfdbfe}.cover h1{position:relative;z-index:1;margin:0;max-width:760px;font-size:30px;line-height:1.08;letter-spacing:-.04em}.lede{position:relative;z-index:1;max-width:680px;margin:11px 0 0;color:#dbeafe;font-size:11px}.meta-grid{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:26px}.meta-item{padding:10px 12px;border:1px solid rgba(255,255,255,.2);border-radius:10px;background:rgba(5,24,59,.2)}.meta-label{margin:0;color:#bfdbfe;font-size:8px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.meta-value{margin:4px 0 0;font-size:10px;font-weight:700}.section{margin-top:24px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:10px}.section-head h2{margin:0;font-size:16px;letter-spacing:-.02em}.section-kicker{margin:0 0 4px;color:var(--blue)}.section-caption{margin:0;color:var(--muted);font-size:9px}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.metric-card,.chart-card,.empty-card,.audit-card{break-inside:avoid;border:1px solid var(--line);border-radius:12px;background:#fff}.metric-card{position:relative;padding:13px}.metric-label{margin:0;color:var(--muted);font-size:8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.metric-value{margin:11px 0 4px;font-size:22px;font-weight:800;letter-spacing:-.04em}.metric-value span{color:var(--muted);font-size:10px;font-weight:700}.metric-detail{min-height:27px;margin:0;color:var(--muted);font-size:9px}.quality-pill{display:inline-block;margin:7px 4px 0 0;padding:3px 6px;border-radius:999px;font-size:7px;font-weight:800;letter-spacing:.07em;text-transform:uppercase}.quality-validated{color:var(--green);background:var(--green-soft)}.quality-source{color:#155eef;background:var(--blue-soft)}.quality-raw{color:var(--amber);background:var(--amber-soft)}.provenance-live{color:var(--green);background:var(--green-soft)}.provenance-latest{color:#155eef;background:var(--blue-soft)}.provenance-history{color:#475569;background:#f1f5f9}.chart-grid line{stroke:#e8eef5;stroke-width:1}.chart-labels{fill:#7b8ba1;font-size:8px}.chart-line{fill:none;stroke:#155eef;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.chart-dot{fill:#fff;stroke:#155eef;stroke-width:3}.chart-grid,.chart-labels{font-family:inherit}.chart-grid+ .chart-labels{}.charts-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.chart-card{padding:14px}.chart-heading{display:flex;justify-content:space-between;gap:10px;align-items:start}.chart-heading h3,.empty-card h3,.audit-card h3{margin:0;font-size:12px}.chart-unit{padding:4px 7px;border-radius:999px;background:var(--blue-soft);color:var(--blue);font-size:8px;font-weight:800}.report-chart{display:block;width:100%;height:180px;margin-top:8px}.empty-card{padding:18px;color:var(--muted)}.empty-card p:not(.section-kicker){margin:7px 0 0}.audit-card{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:15px;background:var(--amber-soft);border-color:#f3d98d}.audit-card .section-kicker{color:var(--amber)}.audit-card p{margin:6px 0 0;color:#73540b}.audit-card ul{margin:0;padding:0;list-style:none}.audit-card li{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid rgba(154,103,0,.16);color:#73540b}.audit-card li:last-child{border:0}.audit-card strong{color:var(--amber)}.notes{margin:0;padding-left:16px;color:var(--muted)}.notes li{margin:4px 0}.table-wrap{overflow:visible;border:1px solid var(--line);border-radius:12px}.evidence-table{width:100%;border-collapse:collapse;table-layout:fixed}.evidence-table th{padding:9px 10px;background:#f3f7fb;color:#52647b;font-size:7px;font-weight:800;letter-spacing:.1em;text-align:left;text-transform:uppercase}.evidence-table th:nth-child(1){width:25%}.evidence-table th:nth-child(2){width:13%}.evidence-table th:nth-child(3){width:14%}.evidence-table th:nth-child(4){width:14%}.evidence-table th:nth-child(5){width:20%}.evidence-table th:nth-child(6){width:14%}.evidence-table td{padding:8px 10px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}.evidence-table tr{break-inside:avoid}.evidence-table strong{font-size:9px}.evidence-table small{display:block;margin-top:2px;color:var(--muted);font-size:8px}.value-cell{font-weight:800}.source-cell{color:#155eef}.empty-table{text-align:center;color:var(--muted);padding:28px!important}.footer{display:flex;justify-content:space-between;gap:20px;margin-top:28px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:8px}@page{size:A4 landscape;margin:12mm}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}main{max-width:none;padding:0}.cover{border-radius:0}.section{margin-top:18px}.table-wrap{border-radius:0}.page-break-before{page-break-before:always}.metric-card,.chart-card,.audit-card{border-color:#dbe4ef}}
  </style></head><body><main><header class="cover"><div class="brand"><span class="brand-mark">✦</span><span>Solar SCADA · Source-backed reporting</span></div><p class="eyebrow">Operational intelligence report</p><h1>${html(result.title)}</h1><p class="lede">A traceable report of source-backed plant evidence. Validated engineering values, source-reported events, provenance, and exclusions remain clearly separated.</p><div class="meta-grid"><div class="meta-item"><p class="meta-label">Plant / site</p><p class="meta-value">${html(result.siteName)}</p></div><div class="meta-item"><p class="meta-label">Reporting period</p><p class="meta-value">${html(result.period.label)}</p></div><div class="meta-item"><p class="meta-label">Generated</p><p class="meta-value">${html(formatDateTime(result.generatedAt))}</p></div><div class="meta-item"><p class="meta-label">Source status</p><p class="meta-value">${html(result.sourceStatus)}</p></div></div></header><section class="section"><div class="section-head"><div><p class="section-kicker">Executive summary</p><h2>What the selected evidence says</h2></div><p class="section-caption">${html(result.attribution)}</p></div><div class="metric-grid">${summary}</div></section><section class="section"><div class="section-head"><div><p class="section-kicker">Performance view</p><h2>Validated trends</h2></div><p class="section-caption">Charts use validated values only</p></div><div class="charts-grid">${charts}</div></section>${exclusions}<section class="section"><div class="section-head"><div><p class="section-kicker">Evidence register</p><h2>Included report records</h2></div><p class="section-caption">${html(result.records.length.toLocaleString())} records · complete selected-period export</p></div><div class="table-wrap"><table class="evidence-table"><thead><tr><th>Parameter / address</th><th>Validated value</th><th>Source-reported</th><th>Device</th><th>Source / observed</th><th>Evidence quality</th></tr></thead><tbody>${rows || emptyRows}</tbody></table></div></section><section class="section"><div class="section-head"><div><p class="section-kicker">Method & traceability</p><h2>Reading this report</h2></div><p class="section-caption">Raw evidence is never silently promoted</p></div><ul class="notes">${notes}</ul></section><footer class="footer"><span>${html(result.attribution)}</span><span>Generated ${html(formatDateTime(result.generatedAt))} · Save this page as PDF from the print dialog</span></footer></main><script>window.addEventListener('load',function(){window.setTimeout(function(){window.focus();window.print()},250)})</script></body></html>`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function localStart(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function rangeFor(filters: Filters) {
  const now = new Date();
  const today = localStart(now);
  const endOfToday = new Date(today);
  endOfToday.setDate(endOfToday.getDate() + 1);
  if (filters.preset === 'custom' && filters.customFrom && filters.customTo) {
    return { from: new Date(`${filters.customFrom}T00:00:00`).toISOString(), to: new Date(`${filters.customTo}T23:59:59.999`).toISOString() };
  }
  if (filters.preset === 'yesterday') {
    const from = new Date(today); from.setDate(from.getDate() - 1);
    return { from: from.toISOString(), to: today.toISOString() };
  }
  if (filters.preset === 'last-7-days') {
    const from = new Date(endOfToday); from.setDate(from.getDate() - 7);
    return { from: from.toISOString(), to: endOfToday.toISOString() };
  }
  if (filters.preset === 'last-30-days') {
    const from = new Date(endOfToday); from.setDate(from.getDate() - 30);
    return { from: from.toISOString(), to: endOfToday.toISOString() };
  }
  if (filters.preset === 'current-month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: from.toISOString(), to: endOfToday.toISOString() };
  }
  if (filters.preset === 'previous-month') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const to = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  return { from: today.toISOString(), to: endOfToday.toISOString() };
}

function toggleSelection(current: string[], value: string) {
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
}

function filterCount(filters: Filters, initialSite: string) {
  return [
    filters.reportType !== 'operations',
    filters.siteName !== initialSite,
    filters.devices.length > 0,
    filters.parameters.length > 0,
    filters.status !== 'all',
    filters.quality !== 'all',
    filters.provenance.length > 0,
    filters.preset !== 'last-7-days',
  ].filter(Boolean).length;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

function u32(value: number) {
  return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
}

function concat(bytes: Uint8Array[]) {
  const length = bytes.reduce((total, value) => total + value.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const value of bytes) { joined.set(value, offset); offset += value.length; }
  return joined;
}

function zipStore(entries: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const checksum = crc32(content);
    const local = concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(content.length), u32(content.length), u16(name.length), u16(0), name, content]);
    locals.push(local);
    central.push(concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(checksum), u32(content.length), u32(content.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += local.length;
  }
  const centralDirectory = concat(central);
  return concat([...locals, centralDirectory, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralDirectory.length), u32(offset), u16(0)]);
}

function column(index: number) {
  let result = '';
  let value = index + 1;
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

function workbook(result: ReportResult) {
  const rows: Array<Array<string | number>> = [
    [result.title],
    ['Site', result.siteName],
    ['Period', result.period.label],
    ['Generated', formatDateTime(result.generatedAt)],
    ['Source status', result.sourceStatus],
    ['Attribution', result.attribution],
    [],
    ['Record type', 'Category', 'Site', 'Device', 'Parameter', 'Validated value', 'Validated unit', 'Source-reported value', 'Source unit', 'Transport raw value', 'Source identity', 'Register address', 'Source', 'Observed', 'Received', 'Provenance', 'Quality', 'Status', 'Reason'],
    ...result.records.map((record) => [record.recordType, record.category, record.siteName, record.deviceName ?? record.deviceId ?? '—', record.displayLabel, record.value ?? '', record.unit, record.sourceReportedValue ?? '', record.sourceReportedUnit ?? '', record.transportRawValue ?? '', record.sourceIdentity ?? '', record.address, record.sourceName, record.observedAt, record.receivedAt, record.provenance, record.quality, record.status ?? '', record.reason ?? '']),
  ];
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, cellIndex) => {
    const ref = `${column(cellIndex)}${rowIndex + 1}`;
    return typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  return zipStore([
    { name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', content: sheet },
  ]);
}

function tone(quality: Quality) {
  return quality === 'validated' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : quality === 'source-reported' ? 'border-blue-500/25 bg-blue-500/10 text-blue-400' : 'border-amber-500/25 bg-amber-500/10 text-amber-400';
}

function provenanceTone(provenance: Provenance) {
  return provenance === 'live' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : provenance === 'latest-saved' ? 'border-blue-500/25 bg-blue-500/10 text-blue-400' : 'border-slate-500/25 bg-slate-500/10 text-slate-400';
}

export default function ReportCenter({ siteName, sites, devices, parameters }: { siteName: string; sites: string[]; devices: Array<{ id: string; name: string; site: string; type: string }>; parameters: string[] }) {
  const [pending, setPending] = useState<Filters>(() => defaultFilters(siteName));
  const [applied, setApplied] = useState<Filters>(() => defaultFilters(siteName));
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [requestNotice, setRequestNotice] = useState('');
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | 'json' | 'pdf' | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const reportRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPending((current) => current.siteName ? current : { ...current, siteName });
    setApplied((current) => current.siteName ? current : { ...current, siteName });
  }, [siteName]);

  const selectedType = REPORT_TYPES.find((type) => type.value === pending.reportType) ?? REPORT_TYPES[0]!;
  const visibleDevices = useMemo(() => devices.filter((device) => !pending.siteName || device.site === pending.siteName), [devices, pending.siteName]);
  const activeFilters = filterCount(applied, siteName);

  const requestReport = async (filters: Filters, options: { page?: number; range?: { from: string; to: string } } = {}) => {
    if (reportRequestRef.current) {
      reportRequestRef.current.abort();
      setRequestNotice('Previous report request cancelled; loading the latest selection.');
    } else {
      setRequestNotice('');
    }
    const controller = new AbortController();
    reportRequestRef.current = controller;
    setLoading(true);
    setError('');
    const page = options.page ?? 1;
    const query = buildReportQuery(filters, undefined, { page, pageSize: REPORT_TABLE_PAGE_SIZE, range: options.range });
    try {
      const response = await fetch(`/api/mqtt/reports?${query.toString()}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      const payload = await response.json().catch(() => null) as ReportResult | { message?: string } | null;
      if (!response.ok || !payload || !('records' in payload)) throw new Error(payload && 'message' in payload ? payload.message ?? 'Unable to load report evidence.' : 'Unable to load report evidence.');
      setResult(payload);
      setApplied(filters);
      setTablePage(Math.max(0, (payload.pagination?.page ?? page) - 1));
      setRequestNotice('');
    } catch (requestError) {
      if (controller.signal.aborted || (requestError instanceof DOMException && requestError.name === 'AbortError')) return;
      setResult(null);
      setError(requestError instanceof Error ? requestError.message : 'Unable to load report evidence.');
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
    if (!result) throw new Error('Load a report preview before creating an export.');
    const query = buildReportQuery(applied, undefined, { complete: true, range: result.period });
    const response = await fetch(`/api/mqtt/reports?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => null) as ReportResult | { message?: string } | null;
    if (!response.ok || !payload || !('records' in payload) || payload.pagination?.complete !== true) {
      throw new Error(payload && 'message' in payload ? payload.message ?? 'Unable to retrieve the complete report evidence.' : 'Unable to retrieve the complete report evidence.');
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
      setError(exportError instanceof Error ? exportError.message : 'Unable to create the complete report export.');
    } finally {
      setExporting(null);
    }
  };

  const exportCsv = () => runExport('csv', (completeResult) => {
    const metadata = [['Report', completeResult.title], ['Site', completeResult.siteName], ['Period', completeResult.period.label], ['Generated', completeResult.generatedAt], ['Source status', completeResult.sourceStatus], ['Attribution', completeResult.attribution]];
    const headers = ['Record type', 'Category', 'Site', 'Device', 'Parameter', 'Validated value', 'Validated unit', 'Source-reported value', 'Source unit', 'Transport raw value', 'Source identity', 'Register address', 'Source', 'Observed', 'Received', 'Provenance', 'Quality', 'Status', 'Reason'];
    const lines = [...metadata.map((row) => row.map(csvValue).join(',')), '', headers.join(','), ...completeResult.records.map((record) => [record.recordType, record.category, record.siteName, record.deviceName ?? record.deviceId ?? '', record.displayLabel, record.value ?? '', record.unit, record.sourceReportedValue ?? '', record.sourceReportedUnit ?? '', record.transportRawValue ?? '', record.sourceIdentity ?? '', record.address, record.sourceName, record.observedAt, record.receivedAt, record.provenance, record.quality, record.status ?? '', record.reason ?? ''].map(csvValue).join(','))];
    download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `scada-${completeResult.category}-report.csv`);
  });

  const exportJson = () => runExport('json', (completeResult) => download(new Blob([JSON.stringify(completeResult, null, 2)], { type: 'application/json' }), `scada-${completeResult.category}-report.json`));
  const exportXlsx = () => runExport('xlsx', (completeResult) => download(new Blob([workbook(completeResult)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `scada-${completeResult.category}-report.xlsx`));
  const exportPdf = () => {
    if (!result || exporting) return;
    const printWindow = window.open('', '_blank', 'width=1280,height=900');
    if (!printWindow) { setError('Your browser blocked the print window. Allow pop-ups to create the PDF.'); return; }
    printWindow.opener = null;
    printWindow.document.write('<!doctype html><title>Preparing report…</title><body style="font:16px system-ui;padding:32px;color:#172033">Preparing the complete report for print…</body>');
    printWindow.document.close();
    void runExport('pdf', (completeResult) => {
      printWindow.document.open();
      printWindow.document.write(buildPdfReportHtml(completeResult));
      printWindow.document.close();
      printWindow.focus();
    });
  };
  const reportRecords = result?.records ?? [];
  const tablePageCount = Math.max(1, result?.pagination?.totalPages ?? Math.ceil(reportRecords.length / REPORT_TABLE_PAGE_SIZE));
  const visibleTablePage = Math.min(tablePage, tablePageCount - 1);
  const tableStart = (result?.pagination?.page ? result.pagination.page - 1 : visibleTablePage) * REPORT_TABLE_PAGE_SIZE;
  const tableTotal = result?.pagination?.totalRecords ?? reportRecords.length;
  const tableEnd = Math.min(tableStart + reportRecords.length, tableTotal);
  const visibleRecords = reportRecords;
  const changeTablePage = (nextPage: number) => {
    if (loading || nextPage < 0 || nextPage >= tablePageCount) return;
    void requestReport(applied, { page: nextPage + 1, range: result ? { from: result.period.from, to: result.period.to } : undefined });
  };

  return (
    <div data-testid="screen-reports" className="scada-report-center animate-rise-in space-y-5">
      <header className="scada-report-hero rounded-2xl border border-[#1E293B] bg-[linear-gradient(110deg,rgba(37,99,235,.13),transparent_45%),#090B13] p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-blue-400">SCADA / Report Center</p><h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-100 sm:text-3xl">Source-backed operational reporting</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Inspect genuine live and persisted plant evidence. Live MQTT monitoring continues independently while reports load.</p></div>
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-right"><p className="text-[9px] font-bold uppercase tracking-wider text-blue-300">Active filters</p><p data-testid="report-active-filter-count" className="mt-1 text-xl font-bold text-blue-100">{activeFilters}</p></div>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5">
          <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Filter size={16} className="text-blue-400" /><h2 className="text-sm font-bold text-slate-100">Report filters</h2></div><span className="text-[10px] text-slate-500">Does not pause MQTT</span></div>
          <div className="mt-4 space-y-4">
            <label className="block"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Report category</span><select data-testid="report-type-select" value={pending.reportType} onChange={(event) => setPending({ ...pending, reportType: event.target.value as ReportType })} className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-3 py-2 text-sm font-semibold text-slate-200 focus-ring">{REPORT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select><p className="mt-1 text-[10px] leading-4 text-slate-500">{selectedType.description}</p></label>
            <label className="block"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Plant / site</span><select value={pending.siteName} onChange={(event) => setPending({ ...pending, siteName: event.target.value, devices: [] })} className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-3 py-2 text-sm text-slate-200 focus-ring"><option value="">All configured sites</option>{Array.from(new Set([siteName, ...sites])).filter(Boolean).map((site) => <option key={site} value={site}>{site}</option>)}</select></label>
            <fieldset><legend className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Devices</legend><div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-[#334155] bg-[#0F1322] p-2 scrollbar-thin">{visibleDevices.filter((device) => device.type === 'Power inverter').length ? visibleDevices.filter((device) => device.type === 'Power inverter').map((device) => <label key={device.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-slate-300 hover:bg-[#1E293B]"><input type="checkbox" checked={pending.devices.includes(device.id)} onChange={() => setPending({ ...pending, devices: toggleSelection(pending.devices, device.id) })} />{device.name}</label>) : <p className="px-1 py-1 text-xs text-slate-500">No inverters available for this site.</p>}</div></fieldset>
            <fieldset><legend className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Parameters</legend><div className="mt-1.5 max-h-28 space-y-1 overflow-y-auto rounded-lg border border-[#334155] bg-[#0F1322] p-2 scrollbar-thin">{parameters.slice(0, 40).length ? parameters.slice(0, 40).map((parameter) => <label key={parameter} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-slate-300 hover:bg-[#1E293B]"><input type="checkbox" checked={pending.parameters.includes(parameter)} onChange={() => setPending({ ...pending, parameters: toggleSelection(pending.parameters, parameter) })} /><span className="truncate">{parameter}</span></label>) : <p className="px-1 py-1 text-xs text-slate-500">Parameter choices appear after source evidence arrives.</p>}</div></fieldset>
            <div className="grid grid-cols-2 gap-3"><label><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Status</span><select value={pending.status} onChange={(event) => setPending({ ...pending, status: event.target.value as Filters['status'] })} className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-2 py-2 text-xs text-slate-200 focus-ring"><option value="all">All</option><option value="active">Source active</option><option value="warning">Warning</option><option value="normal">Normal</option></select></label><label><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Quality</span><select value={pending.quality} onChange={(event) => setPending({ ...pending, quality: event.target.value as Filters['quality'] })} className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-2 py-2 text-xs text-slate-200 focus-ring"><option value="all">Included values</option><option value="validated">Validated only</option><option value="source-reported">Events only</option></select></label></div>
            <fieldset><legend className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Evidence provenance</legend><div className="mt-1.5 grid grid-cols-1 gap-1">{(['live', 'latest-saved', 'historical-saved'] as Provenance[]).map((provenance) => <label key={provenance} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-slate-300 hover:bg-[#1E293B]"><input type="checkbox" checked={pending.provenance.includes(provenance)} onChange={() => setPending({ ...pending, provenance: toggleSelection(pending.provenance, provenance) as Provenance[] })} />{provenance.replace('-', ' ')}</label>)}</div></fieldset>
            <label className="block"><span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Reporting period</span><select data-testid="report-range-select" value={pending.preset} onChange={(event) => setPending({ ...pending, preset: event.target.value as DatePreset })} className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-3 py-2 text-sm text-slate-200 focus-ring"><option value="today">Daily · today</option><option value="yesterday">Daily · yesterday</option><option value="last-7-days">Periodic · last 7 days</option><option value="last-30-days">Periodic · last 30 days</option><option value="current-month">Periodic · current month</option><option value="previous-month">Periodic · previous month</option><option value="custom">Custom date &amp; time</option></select></label>
            {pending.preset === 'custom' && <div className="grid grid-cols-2 gap-2"><label><span className="text-[10px] text-slate-500">From date</span><input type="date" value={pending.customFrom} onChange={(event) => setPending({ ...pending, customFrom: event.target.value })} className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-2 py-2 text-xs text-slate-200 focus-ring" /></label><label><span className="text-[10px] text-slate-500">From time</span><input type="time" value={pending.customFromTime} onChange={(event) => setPending({ ...pending, customFromTime: event.target.value })} className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-2 py-2 text-xs text-slate-200 focus-ring" /></label><label><span className="text-[10px] text-slate-500">To date</span><input type="date" value={pending.customTo} onChange={(event) => setPending({ ...pending, customTo: event.target.value })} className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-2 py-2 text-xs text-slate-200 focus-ring" /></label><label><span className="text-[10px] text-slate-500">To time</span><input type="time" value={pending.customToTime} onChange={(event) => setPending({ ...pending, customToTime: event.target.value })} className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0F1322] px-2 py-2 text-xs text-slate-200 focus-ring" /></label></div>}
            <div className="grid grid-cols-2 gap-2 border-t border-[#1E293B] pt-4"><button type="button" data-testid="button-apply-report" onClick={() => void requestReport(pending)} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-xs font-bold text-white hover:bg-blue-500 disabled:opacity-60 focus-ring">{loading ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}{loading ? 'Loading' : 'Apply'}</button><button type="button" onClick={() => { const reset = defaultFilters(siteName); setPending(reset); void requestReport(reset); }} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#334155] bg-[#0F1322] px-3 py-2.5 text-xs font-semibold text-slate-300 hover:bg-[#1E293B] disabled:opacity-60 focus-ring"><RotateCcw size={14} />Reset</button></div>
          </div>
        </aside>

        <section className="min-w-0 space-y-5">
          {(loading || requestNotice || exporting) && <div role="status" data-testid="report-request-status" className="flex items-center justify-center gap-2 rounded-xl border border-blue-500/20 bg-blue-500/[.04] px-4 py-3 text-xs text-blue-200"><RefreshCw size={14} className={loading || exporting ? 'animate-spin text-blue-400' : 'text-blue-400'} />{exporting ? `Retrieving complete evidence for ${exporting.toUpperCase()} export…` : loading ? 'Loading source-backed report evidence…' : requestNotice}</div>}
          {!loading && error && <div role="alert" className="rounded-2xl border border-rose-500/25 bg-rose-500/[.06] p-5 text-sm text-rose-200"><AlertTriangle size={17} className="mr-2 inline text-rose-400" />{error}<button type="button" onClick={() => void requestReport(applied)} className="ml-3 font-semibold text-rose-300 underline focus-ring">Try again</button></div>}
          {!error && result && <>
            <div className="rounded-2xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><p className="text-[10px] font-bold uppercase tracking-[.18em] text-blue-400">Preview ready</p><span className="rounded-full border border-[#334155] bg-[#0F1322] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">{result.category.replace('-', ' ')}</span></div><h2 className="mt-2 text-xl font-bold text-slate-100">{result.title}</h2><p className="mt-1 text-sm text-slate-400">{result.siteName} <span className="px-1 text-slate-600">•</span> {result.period.label}</p><p className="mt-2 text-[11px] text-slate-500">{result.sourceStatus}</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={exportCsv} data-testid="button-report-export-csv" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-400 hover:bg-emerald-500/20 focus-ring"><Download size={14} />CSV</button><button type="button" onClick={exportXlsx} data-testid="button-report-export-xlsx" className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-400 hover:bg-blue-500/20 focus-ring"><FileSpreadsheet size={14} />Excel</button><button type="button" onClick={exportJson} data-testid="button-report-export-json" className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-xs font-bold text-violet-400 hover:bg-violet-500/20 focus-ring"><FileJson size={14} />JSON</button><button type="button" onClick={exportPdf} data-testid="button-report-export-pdf" className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-400 hover:bg-rose-500/20 focus-ring"><FileText size={14} />PDF</button><button type="button" onClick={() => void requestReport(applied)} aria-label="Refresh report preview" className="inline-flex items-center justify-center rounded-lg border border-[#334155] bg-[#0F1322] px-3 py-2 text-slate-300 hover:bg-[#1E293B] focus-ring"><RefreshCw size={14} /></button></div></div>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[#1E293B] pt-3 text-[10px] text-slate-500"><span><strong className="text-slate-300">Generated:</strong> {formatDateTime(result.generatedAt)}</span><span><strong className="text-slate-300">Latest observed:</strong> {result.freshness.latestObservedAt ? formatDateTime(result.freshness.latestObservedAt) : 'No included evidence'}</span><span><strong className="text-slate-300">Latest received:</strong> {result.freshness.latestReceivedAt ? formatDateTime(result.freshness.latestReceivedAt) : 'No included evidence'}</span><span><strong className="text-slate-300">Filters:</strong> {activeFilters ? `${activeFilters} active` : 'Default scope'}</span><span><strong className="text-slate-300">Attribution:</strong> {result.attribution}</span></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">{result.summary.map((item) => <article key={item.label} className="rounded-xl border border-[#1E293B] bg-[#090B13] p-4"><div className="flex items-start justify-between gap-2"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{item.label}</p><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone(item.quality)}`}>{item.quality.replace('-', ' ')}</span></div><p className="mt-3 text-2xl font-bold text-slate-100">{Number(item.value).toLocaleString()} <span className="text-sm text-slate-500">{item.unit}</span></p><p className="mt-2 text-[11px] leading-4 text-slate-500">{item.detail}</p></article>)}</div>
            {result.charts.map((chart) => <section key={chart.title} className="rounded-2xl border border-[#1E293B] bg-[#090B13] p-4 sm:p-5"><div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Trend</p><h3 className="mt-1 text-sm font-bold text-slate-100">{chart.title}</h3></div><BarChart3 size={18} className="text-blue-400" /></div><div className="mt-4 h-56"><ResponsiveContainer width="100%" height="100%">{chart.kind === 'bar' ? <BarChart data={chart.data}><CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} /><XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip contentStyle={{ background: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: 10 }} formatter={(value) => [`${Number(value).toLocaleString()} ${chart.unit}`, 'Validated value']} /><Bar dataKey="value" fill="#2563EB" radius={[4, 4, 0, 0]} /></BarChart> : chart.kind === 'area' ? <AreaChart data={chart.data}><CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} /><XAxis dataKey="time" hide /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip contentStyle={{ background: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: 10 }} /><Area type="monotone" dataKey="value" stroke="#0EA5E9" fill="#0EA5E933" /></AreaChart> : <LineChart data={chart.data}><CartesianGrid strokeDasharray="3 3" stroke="#1E293B" vertical={false} /><XAxis dataKey="time" tickFormatter={(value) => new Date(value).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })} tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} minTickGap={20} /><YAxis tick={{ fill: 'var(--scada-muted)', fontSize: 10 }} /><Tooltip contentStyle={{ background: 'var(--scada-tooltip)', borderColor: 'var(--scada-border)', borderRadius: 10 }} formatter={(value) => [`${Number(value).toLocaleString()} ${chart.unit}`, 'Validated value']} /><Line type="monotone" dataKey="value" stroke="#2563EB" strokeWidth={2} dot={false} /></LineChart>}</ResponsiveContainer></div></section>)}
            <div className="grid gap-4 lg:grid-cols-3"><section className="rounded-2xl border border-[#1E293B] bg-[#090B13] p-4"><div className="flex items-center gap-2"><AlertTriangle size={16} className={result.alarmSummary.reported ? 'text-rose-400' : 'text-emerald-400'} /><h3 className="text-sm font-bold text-slate-100">Alarm & fault summary</h3></div><p className="mt-3 text-2xl font-bold text-slate-100">{result.alarmSummary.reported}</p><p className="mt-1 text-[11px] text-slate-500">Source-reported alarm/fault records. Active state is shown only when the source declares it.</p></section><section className="rounded-2xl border border-[#1E293B] bg-[#090B13] p-4"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-blue-400" /><h3 className="text-sm font-bold text-slate-100">Communication context</h3></div><p className="mt-3 text-2xl font-bold text-slate-100">{result.communicationSummary.events}</p><p className="mt-1 text-[11px] text-slate-500">{result.communicationSummary.warnings} source-reported warning event{result.communicationSummary.warnings === 1 ? '' : 's'} in period.</p></section><section className="rounded-2xl border border-amber-500/20 bg-amber-500/[.04] p-4"><div className="flex items-center gap-2"><AlertTriangle size={16} className="text-amber-400" /><h3 className="text-sm font-bold text-slate-100">Excluded evidence</h3></div><p className="mt-3 text-2xl font-bold text-slate-100">{result.excludedEvidence.count}</p><p className="mt-1 text-[11px] text-slate-500">Raw/unvalidated values were retained as an audit count, not converted into customer-facing values.</p></section></div>
            <section className="rounded-2xl border border-[#1E293B] bg-[#090B13]"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#1E293B] p-4 sm:p-5"><div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Detailed evidence</p><h3 className="mt-1 text-sm font-bold text-slate-100">Validated and source-reported report records</h3><p className="mt-1 text-[11px] text-slate-500">Source-reported values are evidence only; they do not power validated trends or KPIs.</p></div><span className="rounded-full border border-[#334155] bg-[#0F1322] px-2.5 py-1 text-[10px] font-bold text-slate-400">{result.records.length.toLocaleString()} rows</span></div>{reportRecords.length > REPORT_TABLE_PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1E293B] px-4 py-3 text-xs text-slate-400 sm:px-5"><p>Viewing <strong className="text-slate-200">{(tableStart + 1).toLocaleString()}–{Math.min(tableStart + REPORT_TABLE_PAGE_SIZE, reportRecords.length).toLocaleString()}</strong> of {reportRecords.length.toLocaleString()} records. Exports include the full selected period.</p><div className="flex items-center gap-2"><button type="button" aria-label="Previous report table page" disabled={visibleTablePage === 0} onClick={() => setTablePage((page) => Math.max(0, page - 1))} className="inline-flex items-center rounded-md border border-[#334155] bg-[#0F1322] p-1.5 text-slate-300 hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:opacity-40 focus-ring"><ChevronLeft size={15} /></button><span className="font-mono text-[11px] text-slate-500">{visibleTablePage + 1} / {tablePageCount}</span><button type="button" aria-label="Next report table page" disabled={visibleTablePage >= tablePageCount - 1} onClick={() => setTablePage((page) => Math.min(tablePageCount - 1, page + 1))} className="inline-flex items-center rounded-md border border-[#334155] bg-[#0F1322] p-1.5 text-slate-300 hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:opacity-40 focus-ring"><ChevronRight size={15} /></button></div></div>}<div className="max-w-full overflow-x-auto scrollbar-thin" data-scroll-region="report-records"><table className="w-full min-w-[1540px] text-left"><thead className="bg-[#0F1322]"><tr>{['Parameter', 'Validated value', 'Source-reported value', 'Transport raw', 'Device', 'Source', 'Observed', 'Received', 'Provenance', 'Quality', 'Status'].map((heading) => <th key={heading} className="px-4 py-3 text-[9px] font-bold uppercase tracking-wider text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-[#1E293B]">{reportRecords.length ? visibleRecords.map((record) => <tr key={record.id} className="hover:bg-[#1E293B]/35"><td className="px-4 py-3"><p className="text-xs font-semibold text-slate-200">{record.displayLabel}</p><p className="mt-0.5 font-mono text-[10px] text-slate-500">{record.address}{record.sourceIdentity ? ` · ${record.sourceIdentity}` : ''}</p></td><td className="px-4 py-3 text-xs font-mono font-bold text-slate-100">{record.value === null ? '—' : `${record.value.toLocaleString()} ${record.unit}`}</td><td className="px-4 py-3 text-xs font-mono text-blue-200">{record.sourceReportedValue ? `${record.sourceReportedValue} ${record.sourceReportedUnit ?? 'Raw / not declared'}` : '—'}</td><td className="px-4 py-3 text-xs font-mono text-slate-400">{record.transportRawValue ?? '—'}</td><td className="px-4 py-3 text-xs text-slate-300">{record.deviceName ?? record.deviceId ?? 'Plant context'}</td><td className="px-4 py-3 text-xs text-slate-300">{record.sourceName}</td><td className="px-4 py-3 text-[11px] text-slate-400">{formatDateTime(record.observedAt)}</td><td className="px-4 py-3 text-[11px] text-slate-400">{formatDateTime(record.receivedAt)}</td><td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${provenanceTone(record.provenance)}`}>{record.provenance.replace('-', ' ')}</span></td><td className="px-4 py-3"><span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone(record.quality)}`}>{record.quality.replace('-', ' ')}</span></td><td className="px-4 py-3 text-xs text-slate-400">{record.status ?? record.reason ?? '—'}</td></tr>) : <tr><td colSpan={11} className="px-5 py-12 text-center text-sm text-slate-500">No included source records match the selected filters. Review excluded evidence before widening the report scope.</td></tr>}</tbody></table></div></section>
             {tableTotal > REPORT_TABLE_PAGE_SIZE && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#1E293B] bg-[#090B13] px-4 py-3 text-xs text-slate-400"><p>Viewing <strong className="text-slate-200">{(tableStart + 1).toLocaleString()}–{tableEnd.toLocaleString()}</strong> of {tableTotal.toLocaleString()} records. Exports use complete selected-period evidence.</p><div className="flex items-center gap-2"><button type="button" aria-label="Previous report evidence page" disabled={loading || visibleTablePage === 0} onClick={() => changeTablePage(visibleTablePage - 1)} className="inline-flex items-center rounded-md border border-[#334155] bg-[#0F1322] p-1.5 text-slate-300 hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:opacity-40 focus-ring"><ChevronLeft size={15} /></button><span className="font-mono text-[11px] text-slate-500">{visibleTablePage + 1} / {tablePageCount}</span><button type="button" aria-label="Next report evidence page" disabled={loading || visibleTablePage >= tablePageCount - 1} onClick={() => changeTablePage(visibleTablePage + 1)} className="inline-flex items-center rounded-md border border-[#334155] bg-[#0F1322] p-1.5 text-slate-300 hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:opacity-40 focus-ring"><ChevronRight size={15} /></button></div></div>}
            {result.excludedEvidence.count > 0 && <details className="rounded-2xl border border-amber-500/20 bg-amber-500/[.035] p-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold text-amber-200 focus-ring"><span>Why some evidence is excluded</span><ChevronDown size={16} /></summary><p className="mt-3 text-xs leading-5 text-amber-100/70">The Report Center never estimates engineering values from raw registers. The following evidence was retained only as an audit explanation:</p><ul className="mt-3 space-y-2">{result.excludedEvidence.byReason.map((item) => <li key={item.reason} className="flex justify-between gap-3 rounded-lg border border-amber-500/15 bg-[#090B13]/40 px-3 py-2 text-xs"><span className="text-slate-300">{item.reason}</span><span className="shrink-0 font-mono text-amber-300">{item.count}</span></li>)}</ul></details>}
            <footer className="rounded-xl border border-[#1E293B] bg-[#090B13] px-4 py-3 text-center text-[10px] font-semibold tracking-wide text-slate-500">{result.qualityNotes.map((note) => <p key={note} className="mb-1 last:mb-0">{note}</p>)}<p className="mt-2 text-slate-400">{result.attribution}</p></footer>
          </>}
        </section>
      </div>
    </div>
  );
}