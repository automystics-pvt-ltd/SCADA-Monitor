import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceParameterQueryId, discoveryDeviceIdFromSourceRecord } from './device-discovery-identity.ts';

test('uses a generic MQTT source identity instead of its register name', () => {
  const discoveryId = discoveryDeviceIdFromSourceRecord({ server_name: 'PLC-West', name: 'active_power' }, 'PLC-West');
  assert.equal(discoveryId, 'source:PLC-West');
  assert.equal(deviceParameterQueryId({
    id: 'source-PLC-West-active-power',
    energyInverterId: 'active_power',
    discoveryDeviceId: discoveryId,
  }), 'source:PLC-West');
});

test('prefers explicitly reported device identifiers for discovery', () => {
  assert.equal(discoveryDeviceIdFromSourceRecord({ device_id: 'INV-A', server_name: 'PLC-West' }, 'PLC-West'), 'INV-A');
});