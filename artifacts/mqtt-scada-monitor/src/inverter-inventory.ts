import type { RawInverterSignal } from './telemetry-kpis';

function normalized(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function signalTime(signal: RawInverterSignal) {
  const timestamp = signal.observedAt ? Date.parse(signal.observedAt) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function signalPriority(signal: RawInverterSignal) {
  const parameter = normalized(signal.parameter);
  if (signal.signalKind === 'identity') return 1;
  if (/^inv\d+(activepower|acpower|power)?$/.test(parameter)) return 4;
  if (['activepower', 'acpower', 'acoutput', 'inverteracoutput', 'inverteroutputpower'].includes(parameter)) return 3;
  return 2;
}

/**
 * A source can publish several registers for one physical inverter. Inventory
 * views must group by the explicit mapped inverter identity, not by register.
 * A direct inverter power tag is preferred over broad source data; an identity
 * signal remains a truthful fallback when no power signal exists.
 */
export function inverterInventoryKey(signal: RawInverterSignal) {
  const source = normalized(signal.sourceName) || 'mqttsource';
  const inverter = normalized(signal.inverterId);
  if (inverter) return `${source}|inverter:${inverter}`;
  return `${source}|register:${normalized(signal.address)}|${normalized(signal.parameter)}`;
}

export function uniqueInverterInventorySignals(signals: RawInverterSignal[]) {
  const selected = new Map<string, RawInverterSignal>();
  for (const signal of signals) {
    const key = inverterInventoryKey(signal);
    const current = selected.get(key);
    if (
      !current
      || signalPriority(signal) > signalPriority(current)
      || (signalPriority(signal) === signalPriority(current) && signalTime(signal) >= signalTime(current))
    ) {
      selected.set(key, signal);
    }
  }
  return [...selected.values()].sort((left, right) => {
    const leftName = left.inverterId ?? left.parameter;
    const rightName = right.inverterId ?? right.parameter;
    return leftName.localeCompare(rightName);
  });
}