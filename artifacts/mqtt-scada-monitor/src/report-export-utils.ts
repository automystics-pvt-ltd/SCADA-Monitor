// Shared export/rendering helpers for source-backed SCADA report evidence.
// Used by both the Report Center screen and the Saved Data explorer so CSV,
// JSON, Excel (hand-built SpreadsheetML), and print-to-PDF exports stay in
// lockstep for every screen that reports on validated saved evidence.

export type ReportQuality = 'validated' | 'source-reported' | 'raw';
export type ReportProvenance = 'live' | 'latest-saved' | 'historical-saved';

export type ReportRecord = {
  id: string;
  recordType: 'measurement' | 'energy' | 'snapshot' | 'alarm' | 'communication';
  category: string;
  siteName: string;
  deviceId: string | null;
  deviceName: string | null;
  parameter: string;
  displayLabel: string;
  measurementKind?: string;
  value: number | null;
  unit: string;
  address: string;
  sourceName: string;
  observedAt: string;
  receivedAt: string;
  provenance: ReportProvenance;
  quality: ReportQuality;
  status: string | null;
  reason: string | null;
  sourceReportedValue?: string | null;
  sourceReportedUnit?: string | null;
  transportRawValue?: string | null;
  sourceIdentity?: string | null;
};

export type ReportResult = {
  title: string;
  category: string;
  siteName: string;
  period: { from: string; to: string; label: string };
  generatedAt: string;
  sourceStatus: string;
  freshness: { latestObservedAt: string | null; latestReceivedAt: string | null };
  filters: Record<string, unknown>;
  summary: Array<{ label: string; value: number | string; unit: string; detail: string; quality: ReportQuality }>;
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

export function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not reported' : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(date);
}

// Saved telemetry text (parameter names, source identities, raw values, reasons, etc.) is
// externally supplied evidence, not operator input. Spreadsheet apps treat a cell starting with
// =, +, -, @, tab, or CR as a formula, so a malicious/garbled source string could execute when an
// operator opens the export in Excel/Sheets (CSV/XLSX formula injection). Neutralize it by
// prefixing a leading single quote, which spreadsheet apps render as literal text instead of
// evaluating it. Applied to every text cell in both the CSV and XLSX export paths.
const CSV_FORMULA_LEADING_CHARACTERS = /^[=+\-@\t\r]/;

export function sanitizeSpreadsheetText(value: unknown) {
  const text = String(value ?? '');
  return CSV_FORMULA_LEADING_CHARACTERS.test(text) ? `'${text}` : text;
}

export function csvValue(value: unknown) {
  const text = sanitizeSpreadsheetText(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function xml(value: unknown) {
  return String(value ?? '').replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character] ?? character));
}

export function html(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

export function reportQualityClass(quality: ReportQuality) {
  return quality === 'validated' ? 'quality-validated' : quality === 'source-reported' ? 'quality-source' : 'quality-raw';
}

export function reportProvenanceClass(provenance: ReportProvenance) {
  return provenance === 'live' ? 'provenance-live' : provenance === 'latest-saved' ? 'provenance-latest' : 'provenance-history';
}

export function reportChartSvg(chart: ReportResult['charts'][number]) {
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

export function buildPdfReportHtml(result: ReportResult) {
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

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

export function column(index: number) {
  let result = '';
  let value = index + 1;
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

export function workbook(result: ReportResult) {
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
    return typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xml(sanitizeSpreadsheetText(value))}</t></is></c>`;
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
