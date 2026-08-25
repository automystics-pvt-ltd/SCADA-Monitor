type TelemetryEvidence = Record<string, unknown>;

/**
 * A reported/customer value must originate in an explicit source field or a
 * reviewed server mapping. A generic `data` field alone is transport evidence,
 * not proof that it is customer-facing engineering evidence.
 */
export function isSourceReportedEvidence(row: TelemetryEvidence) {
  const mappingStatus = row.source_mapping_status ?? row.sourceMappingStatus;
  if (mappingStatus !== undefined && mappingStatus !== null && mappingStatus !== '') {
    return mappingStatus === 'source-reported';
  }
  return row.reported_value !== undefined
    || row.reportedValue !== undefined
    || row.customer_value !== undefined
    || row.customerValue !== undefined
    || row.engineering_value !== undefined
    || row.engineeringValue !== undefined;
}

export function sourceReportedTelemetryValue(row: TelemetryEvidence): unknown {
  if (!isSourceReportedEvidence(row)) return undefined;
  return row.reported_value ?? row.reportedValue ?? row.customer_value ?? row.customerValue ?? row.engineering_value ?? row.engineeringValue;
}

export function transportRawTelemetryValue(row: TelemetryEvidence): unknown {
  return row.raw_data ?? row.rawValue ?? row.raw_value ?? row.source_raw_value ?? row.sourceRawValue ?? row.data;
}