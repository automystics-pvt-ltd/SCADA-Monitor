import assert from 'node:assert/strict';
import test from 'node:test';

import { uniqueInverterInventorySignals } from './inverter-inventory.ts';

test('groups multiple source registers into one physical inverter inventory item', () => {
  const signals = uniqueInverterInventorySignals([
    { parameter: 'pf', value: 1000, address: '305035', provenance: 'replay', sourceName: 'ana', inverterId: 'inv1', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'actpow', value: 597819392, address: '305031', provenance: 'replay', sourceName: 'ana', inverterId: 'inv1', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'inv1', value: 3977, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv1', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'inv2', value: 3977, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv2', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'inv3', value: 3977, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv3', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'inv4', value: 3977, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv4', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'inv5', value: 3977, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv5', observedAt: '2026-08-26T05:00:00.000Z' },
  ]);

  assert.equal(signals.length, 5);
  assert.deepEqual(signals.map((signal) => signal.inverterId), ['inv1', 'inv2', 'inv3', 'inv4', 'inv5']);
  assert.equal(signals.find((signal) => signal.inverterId === 'inv1')?.parameter, 'inv1');
});

test('uses identity evidence only when a power-tag candidate is unavailable', () => {
  const signals = uniqueInverterInventorySignals([
    { parameter: 'inv1', value: 1, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv1', signalKind: 'identity', observedAt: '2026-08-26T05:00:00.000Z' },
    { parameter: 'active_power', value: 24, address: '305031', provenance: 'replay', sourceName: 'ana', inverterId: 'inv1', observedAt: '2026-08-26T05:00:01.000Z' },
    { parameter: 'inv2', value: 1, address: '305003', provenance: 'replay', sourceName: 'ana', inverterId: 'inv2', signalKind: 'identity', observedAt: '2026-08-26T05:00:00.000Z' },
  ]);

  assert.equal(signals.length, 2);
  assert.equal(signals.find((signal) => signal.inverterId === 'inv1')?.parameter, 'active_power');
  assert.equal(signals.find((signal) => signal.inverterId === 'inv2')?.signalKind, 'identity');
});