/**
 * Format an ISO timestamp in the plant's configured timezone (falling back
 * to UTC). Shared so every "saved at"/"observed at" label -- across the
 * live dashboard, the saved-only Overview pipeline, and KPI card details --
 * renders identically.
 */
export function formatInPlantTimezone(value: string | undefined, timezone: string | undefined) {
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
