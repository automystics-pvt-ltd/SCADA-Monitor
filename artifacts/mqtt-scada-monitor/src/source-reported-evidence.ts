type TelemetryEvidence = Record<string, unknown>;

function textValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function reportedTelemetryValueCandidate(row: TelemetryEvidence): unknown {
  const mappingStatus = row.source_mapping_status ?? row.sourceMappingStatus;
  // A mapping explicitly marked raw is transport-only, even if an upstream
  // convenience field happens to resemble a reported value.
  if (mappingStatus !== undefined && mappingStatus !== null && mappingStatus !== '' && mappingStatus !== 'source-reported') return undefined;
  return row.reported_value ?? row.reportedValue ?? row.customer_value ?? row.customerValue ?? row.engineering_value ?? row.engineeringValue;
}

/**
 * A reported/customer value must originate in an explicit source field or a
 * reviewed server mapping. A generic `data` field alone is transport evidence,
 * not proof that it is customer-facing engineering evidence.
 */
export function isSourceReportedEvidence(row: TelemetryEvidence) {
  return reportedTelemetryValueCandidate(row) !== undefined;
}

export function sourceReportedTelemetryValue(row: TelemetryEvidence): unknown {
  return reportedTelemetryValueCandidate(row);
}

export function sourceReportedTelemetryUnit(row: TelemetryEvidence) {
  if (!isSourceReportedEvidence(row)) return undefined;
  return textValue(row.reported_unit)
    ?? textValue(row.reportedUnit)
    ?? textValue(row.customer_unit)
    ?? textValue(row.customerUnit)
    ?? textValue(row.source_unit)
    ?? textValue(row.sourceUnit)
    ?? textValue(row.engineering_unit)
    ?? textValue(row.engineeringUnit);
}

export function transportRawTelemetryValue(row: TelemetryEvidence): unknown {
  return row.raw_data ?? row.rawValue ?? row.raw_value ?? row.source_raw_value ?? row.sourceRawValue ?? row.data;
}