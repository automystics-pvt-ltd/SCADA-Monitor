export type FaultEvidence = {
  id: string;
  code: string | null;
  rawValue: string;
  title: string;
  source: string;
  observedAt: string | null;
  severity: 'fault' | 'warning' | 'info';
  reportedReason: string | null;
  reportedSuggestions: string[];
};

export type FaultGuidance = {
  title: string;
  reason: string;
  suggestions: string[];
  mapping: 'source-reported' | 'reference-mapped' | 'unmapped';
  scope: string;
};

export type AlarmFaultEvidence = {
  alarms: FaultEvidence[];
  faults: FaultEvidence[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function firstText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return null;
}

function formatRawValue(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractCode(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:fault|alarm|error)?\s*(?:code|id)?\s*[:#=-]?\s*([a-z0-9]+(?:[-_][a-z0-9]+)?)/i);
  return match?.[1] ?? (/^\d+$/.test(value.trim()) ? value.trim() : null);
}

function suggestionValues(value: unknown) {
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean);
  const text = textValue(value);
  return text ? text.split(/\r?\n|(?<=\.)\s+(?=\d+\.)/).map((item) => item.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean) : [];
}

function valuesForKeys(record: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => {
    const value = record[key];
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  });
}

function uniqueEvidence(evidence: FaultEvidence[]) {
  return Array.from(new Map(evidence.map((item) => [
    `${item.code ?? ''}|${item.title}|${item.source}|${item.observedAt ?? ''}|${item.rawValue}`,
    item,
  ])).values());
}

export function normalizeFaults(value: unknown, prefix = 'fault'): FaultEvidence[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, index) => {
    if (!isRecord(item)) {
      const rawValue = formatRawValue(item);
      return {
        id: `${prefix}-${index}-${rawValue}`,
        code: extractCode(item),
        rawValue,
        title: extractCode(item) ? `Fault code ${extractCode(item)}` : 'Reported fault',
        source: 'Device telemetry',
        observedAt: null,
        severity: 'fault' as const,
        reportedReason: null,
        reportedSuggestions: [],
      };
    }

    const code = extractCode(item.code ?? item.faultCode ?? item.fault_code ?? item.alarmCode ?? item.alarm_code ?? item.id);
    const rawValue = formatRawValue(item);
    return {
      id: `${prefix}-${index}-${code ?? rawValue}`,
      code,
      rawValue,
      title: firstText(item, ['title', 'name', 'label', 'type']) ?? (code ? `Fault code ${code}` : 'Reported fault'),
      source: firstText(item, ['source', 'alarmSource', 'alarm_source', 'origin', 'system']) ?? 'Device telemetry',
      observedAt: firstText(item, ['observedAt', 'observed_at', 'timestamp', 'time', 'date']),
      severity: (firstText(item, ['severity', 'level'])?.toLowerCase() === 'warning' ? 'warning' : firstText(item, ['severity', 'level'])?.toLowerCase() === 'info' ? 'info' : 'fault') as FaultEvidence['severity'],
      reportedReason: firstText(item, ['cause', 'faultCause', 'fault_cause', 'reason', 'description', 'message']),
      reportedSuggestions: suggestionValues(item.suggestions ?? item.recommendations ?? item.recommendation ?? item.actions),
    };
  });
}

export function collectAlarmFaultEvidence(value: unknown): AlarmFaultEvidence {
  if (!isRecord(value)) return { alarms: [], faults: [] };
  const alarms = valuesForKeys(value, [
    'alarms', 'alarm', 'alarmCode', 'alarm_code', 'alarmStatus', 'alarm_status', 'warnings', 'warning',
  ]).flatMap((item) => normalizeFaults(item, 'alarm'));
  const faults = valuesForKeys(value, [
    'faults', 'fault', 'faultCode', 'fault_code', 'faultStatus', 'fault_status', 'errors', 'error', 'errorCode', 'error_code',
  ]).flatMap((item) => normalizeFaults(item, 'fault'));
  return { alarms: uniqueEvidence(alarms), faults: uniqueEvidence(faults) };
}

export function collectAlarmFaultEvidenceFromRows(value: unknown): AlarmFaultEvidence {
  if (!Array.isArray(value)) return { alarms: [], faults: [] };
  const alarms: FaultEvidence[] = [];
  const faults: FaultEvidence[] = [];
  for (const row of value) {
    if (!isRecord(row)) continue;
    const title = firstText(row, ['name', 'parameter', 'tag', 'registerName', 'register_name', 'label']);
    if (!title || !/(alarm|fault|error|warning)/i.test(title)) continue;
    const kind = /(fault|error)/i.test(title) ? 'fault' : 'alarm';
    const raw = row.raw_data ?? row.rawValue ?? row.raw_value ?? row.data ?? row.value ?? row.currentValue ?? row.current_value;
    const codeValue = /(code|id)/i.test(title) ? raw : row.code ?? row.faultCode ?? row.fault_code ?? row.alarmCode ?? row.alarm_code;
    const evidence: FaultEvidence = {
      id: `${kind}-row-${firstText(row, ['server_name', 'serverName', 'source', 'device', 'server']) ?? 'source'}-${title}-${firstText(row, ['date_iso_8601', 'timestamp', 'date', 'serverReceivedAt']) ?? 'time'}-${formatRawValue(raw)}`,
      code: extractCode(codeValue) ?? (codeValue === undefined || codeValue === null ? null : textValue(codeValue) || null),
      rawValue: formatRawValue(raw),
      title,
      source: firstText(row, ['server_name', 'serverName', 'source', 'device', 'deviceName', 'server']) ?? 'MQTT / Modbus source',
      observedAt: firstText(row, ['date_iso_8601', 'observedAt', 'observed_at', 'timestamp', 'date', 'serverReceivedAt']) ?? null,
      severity: firstText(row, ['severity', 'level'])?.toLowerCase() === 'warning' || kind === 'alarm' ? 'warning' : 'fault',
      reportedReason: firstText(row, ['cause', 'faultCause', 'fault_cause', 'reason', 'description', 'message']),
      reportedSuggestions: suggestionValues(row.suggestions ?? row.recommendations ?? row.recommendation ?? row.actions),
    };
    (kind === 'fault' ? faults : alarms).push(evidence);
  }
  return { alarms: uniqueEvidence(alarms), faults: uniqueEvidence(faults) };
}

const GENERIC_SUGGESTIONS = [
  'Confirm the fault is still active and note the inverter timestamp and raw code.',
  'Check the inverter and site electrical conditions against the approved operating limits.',
  'Review the device manufacturer manual for this exact model and fault code.',
  'Escalate to the authorized service team before acknowledging or resetting the fault.',
];

export function getFaultGuidance(fault: FaultEvidence, deviceModel?: string): FaultGuidance {
  if (fault.reportedReason) {
    return {
      title: fault.title,
      reason: fault.reportedReason,
      suggestions: fault.reportedSuggestions.length ? fault.reportedSuggestions : GENERIC_SUGGESTIONS,
      mapping: 'source-reported',
      scope: deviceModel ? `${deviceModel} · source reported` : 'Source reported',
    };
  }

  if (fault.code === '4') {
    return {
      title: 'Grid undervoltage protection',
      reason: 'Grid voltage is lower than the configured voltage protection threshold.',
      suggestions: [
        'Measure the actual grid voltage at the inverter and confirm the protection setting.',
        'Check whether the utility supply is within the approved operating range.',
        'Inspect the AC cable, breaker, and connection points for loose or high-resistance connections.',
        'If the fault repeats after the grid returns to normal, contact the authorized service team.',
      ],
      mapping: 'reference-mapped',
      scope: deviceModel ? `${deviceModel} · verify against manufacturer manual` : 'Reference grid-protection mapping · verify against manufacturer manual',
    };
  }

  return {
    title: fault.code ? `Fault code ${fault.code}` : fault.title,
    reason: 'Reason not mapped for this source code.',
    suggestions: GENERIC_SUGGESTIONS,
    mapping: 'unmapped',
    scope: deviceModel ? `${deviceModel} · no approved mapping` : 'No approved mapping',
  };
}

export function telemetryText(value: unknown, keys: string[]) {
  return isRecord(value) ? firstText(value, keys) : null;
}