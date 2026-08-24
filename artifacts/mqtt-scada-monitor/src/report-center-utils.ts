export type ReportRequestFilters = {
  reportType: string;
  siteName: string;
  devices: string[];
  parameters: string[];
  status: string;
  quality: string;
  provenance: string[];
  preset: string;
  customFrom: string;
  customTo: string;
  customFromTime?: string;
  customToTime?: string;
};

function startOfLocalDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function reportRange(filters: Pick<ReportRequestFilters, 'preset' | 'customFrom' | 'customTo' | 'customFromTime' | 'customToTime'>, now = new Date()) {
  const today = startOfLocalDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (filters.preset === 'custom' && filters.customFrom && filters.customTo) {
    const startTime = filters.customFromTime || '00:00';
    const endTime = filters.customToTime || '23:59';
    const startSuffix = startTime.length === 5 ? ':00' : '';
    const endSuffix = endTime.length === 5 ? ':59.999' : '';
    return { from: new Date(`${filters.customFrom}T${startTime}${startSuffix}`).toISOString(), to: new Date(`${filters.customTo}T${endTime}${endSuffix}`).toISOString() };
  }
  if (filters.preset === 'yesterday') {
    const from = new Date(today);
    from.setDate(from.getDate() - 1);
    return { from: from.toISOString(), to: today.toISOString() };
  }
  if (filters.preset === 'last-30-days') {
    const from = new Date(tomorrow);
    from.setDate(from.getDate() - 30);
    return { from: from.toISOString(), to: tomorrow.toISOString() };
  }
  if (filters.preset === 'current-month') return { from: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(), to: tomorrow.toISOString() };
  if (filters.preset === 'previous-month') return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString(), to: new Date(today.getFullYear(), today.getMonth(), 1).toISOString() };
  if (filters.preset === 'today') return { from: today.toISOString(), to: tomorrow.toISOString() };
  const from = new Date(tomorrow);
  from.setDate(from.getDate() - 7);
  return { from: from.toISOString(), to: tomorrow.toISOString() };
}

export function buildReportQuery(filters: ReportRequestFilters, now?: Date) {
  const range = reportRange(filters, now);
  const query = new URLSearchParams({ reportType: filters.reportType, from: range.from, to: range.to, quality: filters.quality, status: filters.status });
  if (filters.siteName) query.set('siteName', filters.siteName);
  if (filters.devices.length) query.set('devices', filters.devices.join(','));
  if (filters.parameters.length) query.set('parameters', filters.parameters.join(','));
  if (filters.provenance.length) query.set('provenance', filters.provenance.join(','));
  return query;
}