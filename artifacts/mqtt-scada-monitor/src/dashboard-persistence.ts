export const HISTORICAL_SAVING_RESUME_MESSAGE = 'Data saving resumes at 6:00 AM';

export function persistenceResumeMessage(savingActive: boolean | undefined) {
  return savingActive === false ? HISTORICAL_SAVING_RESUME_MESSAGE : undefined;
}

export function persistenceNextSaveLabel(
  savingActive: boolean | undefined,
  nextScheduledAt: string | undefined,
  now: number,
  intervalMinutes: number,
  formatCountdown: (milliseconds: number) => string,
) {
  const nextSaveAt = nextScheduledAt ? Date.parse(nextScheduledAt) : Number.NaN;
  if (Number.isFinite(nextSaveAt)) {
    return formatCountdown(Math.max(0, nextSaveAt - now));
  }
  return savingActive ? `${intervalMinutes}m cycle` : 'Paused';
}