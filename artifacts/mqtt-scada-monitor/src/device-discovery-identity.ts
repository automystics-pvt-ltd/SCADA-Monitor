export type DiscoveryQueryableDevice = {
  id: string;
  energyInverterId?: string;
  discoveryDeviceId?: string;
};

const explicitDeviceKeys = [
  'device_id',
  'deviceId',
  'inverter_id',
  'inverterId',
  'asset_id',
  'assetId',
  'server_id',
  'serverId',
];

export function discoveryDeviceIdFromSourceRecord(record: Record<string, unknown>, sourceName: string) {
  for (const key of explicitDeviceKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return `source:${sourceName}`;
}

export function deviceParameterQueryId(device: DiscoveryQueryableDevice) {
  return device.discoveryDeviceId ?? device.energyInverterId ?? device.id;
}