export type DeviceParameterFreshness = 'live' | 'stale' | 'saved' | 'retained' | 'recovered' | 'replay';

export type DeviceParameter = {
  observationId: string;
  signalKey: string;
  siteName: string;
  deviceId: string;
  deviceName: string;
  topic: string;
  originalName: string;
  normalizedName: string;
  displayLabel: string;
  category: string;
  rawValue: string;
  value: number | null;
  unit: string | null;
  address: string | null;
  sourceName: string;
  observedAt?: string;
  receivedAt: string;
  provenance: 'live' | 'retained' | 'recovered' | 'replay' | 'snapshot';
  dataQuality: 'validated' | 'raw' | 'source-reported';
  scalingStatus: 'validated' | 'raw';
  ageMs?: number;
  freshness: DeviceParameterFreshness;
};

const categories = [
  'Overview',
  'Electrical',
  'Energy',
  'MPPT / Strings',
  'Temperature',
  'Alarms / Faults',
  'Communication',
  'Discovered / Other Parameters',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDeviceParameters(value: unknown): DeviceParameter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const numeric = typeof item.value === 'number' ? item.value : item.value === null ? null : Number(item.value);
    const provenance = item.provenance;
    const freshness = item.freshness;
    const category = categories.includes(item.category as typeof categories[number])
      ? item.category as typeof categories[number]
      : 'Discovered / Other Parameters';
    if (
      typeof item.observationId !== 'string'
      || typeof item.signalKey !== 'string'
      || typeof item.siteName !== 'string'
      || typeof item.deviceId !== 'string'
      || typeof item.deviceName !== 'string'
      || typeof item.topic !== 'string'
      || typeof item.originalName !== 'string'
      || typeof item.normalizedName !== 'string'
      || typeof item.displayLabel !== 'string'
      || typeof item.rawValue !== 'string'
      || typeof item.sourceName !== 'string'
      || typeof item.receivedAt !== 'string'
      || !['live', 'retained', 'recovered', 'replay', 'snapshot'].includes(String(provenance))
      || !['validated', 'raw', 'source-reported'].includes(String(item.dataQuality))
      || !['validated', 'raw'].includes(String(item.scalingStatus))
      || !['live', 'stale', 'saved', 'retained', 'recovered', 'replay'].includes(String(freshness))
      || (numeric !== null && !Number.isFinite(numeric))
    ) return [];
    return [{
      observationId: item.observationId,
      signalKey: item.signalKey,
      siteName: item.siteName,
      deviceId: item.deviceId,
      deviceName: item.deviceName,
      topic: item.topic,
      originalName: item.originalName,
      normalizedName: item.normalizedName,
      displayLabel: item.displayLabel,
      category,
      rawValue: item.rawValue,
      value: numeric,
      unit: typeof item.unit === 'string' ? item.unit : null,
      address: typeof item.address === 'string' ? item.address : null,
      sourceName: item.sourceName,
      observedAt: typeof item.observedAt === 'string' ? item.observedAt : undefined,
      receivedAt: item.receivedAt,
      provenance: provenance as DeviceParameter['provenance'],
      dataQuality: item.dataQuality as DeviceParameter['dataQuality'],
      scalingStatus: item.scalingStatus as DeviceParameter['scalingStatus'],
      ageMs: typeof item.ageMs === 'number' && Number.isFinite(item.ageMs) ? item.ageMs : undefined,
      freshness: freshness as DeviceParameterFreshness,
    }];
  });
}

export function groupDeviceParameters(parameters: DeviceParameter[]) {
  const grouped = new Map<string, DeviceParameter[]>();
  for (const parameter of parameters) {
    const group = grouped.get(parameter.category) ?? [];
    group.push(parameter);
    grouped.set(parameter.category, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => categories.indexOf(left as typeof categories[number]) - categories.indexOf(right as typeof categories[number]))
    .map(([category, items]) => [category, items.sort((left, right) => left.displayLabel.localeCompare(right.displayLabel) || right.receivedAt.localeCompare(left.receivedAt))] as const);
}

export function deviceParameterPresentation(parameter: DeviceParameter) {
  const isValidatedLive = parameter.scalingStatus === 'validated'
    && parameter.value !== null
    && parameter.provenance === 'live'
    && parameter.freshness === 'live';
  if (isValidatedLive) {
    return {
      isValidatedLive,
      badge: 'VAL',
      title: 'Validated live engineering data',
    };
  }
  const state = parameter.freshness.toUpperCase();
  return {
    isValidatedLive,
    badge: `${state} EVIDENCE`,
    title: `${parameter.freshness} source evidence${parameter.scalingStatus === 'validated' ? ' · scaling confirmed, not live' : ' · raw scaling'}`,
  };
}