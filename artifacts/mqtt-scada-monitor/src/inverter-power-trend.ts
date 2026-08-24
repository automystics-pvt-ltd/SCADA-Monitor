export type PowerTrendSample = {
  id: number | string;
  measurementKind: 'active-power' | 'dc-power' | string;
  scalingStatus: 'validated' | 'raw' | string;
  value: number;
  unit: string;
  observedAt: string;
  receivedAt?: string;
  parameter: string;
  sourceName: string;
  address: string;
};

export type PowerTrendPoint = {
  time: string;
  timestamp: number;
  sampleIdentity: string;
  ac?: number;
  dc?: number;
};

export type PowerTrendState = 'loading' | 'validated' | 'raw-only' | 'unavailable';

function isPowerSample(sample: PowerTrendSample) {
  return sample.measurementKind === 'active-power' || sample.measurementKind === 'dc-power';
}

export function selectValidatedPowerSamples<T extends PowerTrendSample>(samples: T[]) {
  return samples.filter((sample) => sample.scalingStatus === 'validated' && isPowerSample(sample));
}

export function countRawPowerSamples(samples: PowerTrendSample[]) {
  return samples.filter((sample) => sample.scalingStatus === 'raw' && isPowerSample(sample)).length;
}

export function getPowerTrendState(samples: PowerTrendSample[], loading = false): PowerTrendState {
  if (loading) return 'loading';
  if (selectValidatedPowerSamples(samples).length) return 'validated';
  if (countRawPowerSamples(samples)) return 'raw-only';
  return 'unavailable';
}

function readableTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Builds chart points from validated source samples only. AC and DC readings
 * share a point when they have the same observation time; duplicate readings
 * of the same signal keep their own point instead of silently overwriting one
 * another.
 */
export function buildPowerTrendSeries(samples: PowerTrendSample[]): PowerTrendPoint[] {
  const points: PowerTrendPoint[] = [];
  const byTimestamp = new Map<number, PowerTrendPoint>();
  for (const sample of selectValidatedPowerSamples(samples)) {
    const timestamp = Date.parse(sample.observedAt);
    if (!Number.isFinite(timestamp) || !Number.isFinite(sample.value)) continue;
    const kind = sample.measurementKind === 'active-power' ? 'ac' : 'dc';
    const current = byTimestamp.get(timestamp);
    if (current && current[kind] === undefined) {
      current[kind] = sample.value;
      current.sampleIdentity += `|${sample.receivedAt ?? ''}|${sample.id}|${sample.value}`;
      continue;
    }
    const point: PowerTrendPoint = {
      time: readableTime(timestamp),
      timestamp,
      sampleIdentity: `${sample.parameter}|${sample.receivedAt ?? ''}|${sample.id}|${sample.value}`,
      [kind]: sample.value,
    };
    points.push(point);
    if (!current) byTimestamp.set(timestamp, point);
  }
  return points.sort((left, right) => left.timestamp - right.timestamp);
}