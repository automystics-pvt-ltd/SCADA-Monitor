/**
 * Shared JSON-compatible value type. Evidence rows flowing through the
 * telemetry pipeline are always parsed JSON, so shaping helpers that pass
 * rows between modules (App.tsx's Device.telemetry, telemetry-time.ts,
 * inverter-source-devices.ts) need one common definition -- otherwise a
 * `Record<string, unknown>` in a new module silently fails to satisfy a
 * `Record<string, JsonValue>` elsewhere.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;
