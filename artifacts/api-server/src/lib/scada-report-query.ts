import { sql, type SQL } from "drizzle-orm";
import {
  db,
  mqttCommunicationEventsTable,
  mqttInverterEnergyHistoryTable,
  mqttInverterMeasurementHistoryTable,
  mqttSnapshotsTable,
} from "@workspace/db";
import type { ReportFilterSet, ScadaReportRecord, ScadaReportType } from "./scada-reporting";

type QueryArgs = {
  topic: string;
  defaultSite: string;
  siteName: string;
  from: Date;
  to: Date;
  reportType: ScadaReportType;
  filters: ReportFilterSet;
  page: number;
  pageSize: number;
  liveRecord?: ScadaReportRecord;
};

type RecordRow = Omit<ScadaReportRecord, "observedAt" | "receivedAt"> & {
  observedAt: Date | string;
  receivedAt: Date | string;
};

function listCondition(column: SQL, values: string[]) {
  return values.length
    ? sql`lower(${column}) in (${sql.join(values.map((value) => sql`${value.toLowerCase()}`), sql`, `)})`
    : sql`true`;
}

function reportTypeCondition(type: ScadaReportType) {
  const key = sql`lower(parameter || ' ' || display_label)`;
  const power = sql`(measurement_kind in ('active-power', 'dc-power') or ${key} ~ '(ac[ _-]*power|dc[ _-]*power|active[ _-]*power|real[ _-]*power|pv[0-9]*[ _-]*power|input[ _-]*power|power[ _-]*output)')`;
  const mppt = sql`${key} ~ '(mppt|maximum[ _-]*power[ _-]*point|tracker)'`;
  const stringSignal = sql`${key} ~ '(string|pv[ _-]*string|string[ _-]*input|input[ _-]*string)'`;
  const temperature = sql`${key} ~ '(temperature|temp|thermal|heatsink|cabinet)'`;
  const powerFactor = sql`${key} ~ '(power[ _-]*factor|powerfactor|frequency|freq|hz)'`;
  switch (type) {
    case "operations": return sql`category in ('operations', 'inverter', 'alarms', 'communication')`;
    case "electrical": return sql`category = 'electrical'`;
    case "energy":
    case "energy-generation": return sql`category = 'energy'`;
    case "inverter": return sql`category in ('inverter', 'electrical', 'energy')`;
    case "environmental": return sql`category = 'environmental'`;
    case "alarms":
    case "alarm-fault": return sql`category = 'alarms'`;
    case "communication":
    case "device-communication": return sql`category = 'communication'`;
    case "comparison": return sql`category in ('inverter', 'energy', 'electrical')`;
    case "availability": return sql`category in ('communication', 'operations')`;
    case "inverter-monitoring": return sql`(device_id is not null or category = 'inverter')`;
    case "electrical-parameters": return sql`(category = 'electrical' and not ${power} and not ${powerFactor} and not ${mppt} and not ${stringSignal} and not ${temperature})`;
    case "ac-dc-power": return sql`(category in ('electrical', 'operations') and ${power})`;
    case "mppt-monitoring": return sql`(category in ('electrical', 'operations') and ${mppt})`;
    case "string-monitoring": return sql`(category in ('electrical', 'operations') and ${stringSignal})`;
    case "temperature-monitoring": return sql`(category in ('electrical', 'environmental', 'operations') and ${temperature})`;
    case "power-factor-frequency": return sql`(category in ('electrical', 'operations') and ${powerFactor})`;
    case "mqtt-modbus-telemetry": return sql`record_type in ('measurement', 'snapshot', 'communication')`;
    case "live":
    case "live-data": return sql`provenance = 'live'`;
    case "historical":
    case "historical-saved": return sql`provenance in ('latest-saved', 'historical-saved')`;
    default: return sql`true`;
  }
}

function cte(args: QueryArgs) {
  const snapshotSite = sql`coalesce(nullif(p.value->>'site_name', ''), nullif(p.value->>'siteName', ''), nullif(p.value->>'plant_name', ''), nullif(p.value->>'plantName', ''), ${args.defaultSite})`;
  const snapshotParameter = sql`coalesce(nullif(p.value->>'name', ''), nullif(p.value->>'parameter', ''), 'register')`;
  const snapshotCategory = sql`case
    when lower(${snapshotParameter}) ~ '(alarm|fault|trip|error|warning)' then 'alarms'
    when lower(${snapshotParameter}) ~ '(irradiance|temperature|humidity|wind|rain|weather|ambient|environment)' then 'environmental'
    when lower(${snapshotParameter}) ~ '(energy|yield|generation|kwh|mwh)' then 'energy'
    when lower(${snapshotParameter}) ~ '(voltage|current|amper|frequency|powerfactor|reactive|electrical|activepower|acpower|dcpower|realpower)' then 'electrical'
    when lower(${snapshotParameter}) ~ '(inverter|inv)' then 'inverter'
    else 'operations' end`;
  const snapshotValidated = sql`coalesce(p.value->>'scaling_validated', p.value->>'scalingValidated', p.value->>'engineering_value_validated', p.value->>'engineeringValueValidated', p.value->>'scaling_status', p.value->>'scalingStatus', p.value->>'validation_status', p.value->>'validationStatus', '')`;
  const snapshotSourceObserved = sql`coalesce(p.value->>'date_iso_8601', p.value->>'timestamp', p.value->>'date')`;
  const snapshotObserved = sql`case
    when ${snapshotSourceObserved} ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
      then case
        when abs((${snapshotSourceObserved})::numeric) <= 8640000000000000
          then to_timestamp(
            case when abs((${snapshotSourceObserved})::numeric) < 1000000000000
              then (${snapshotSourceObserved})::double precision
              else (${snapshotSourceObserved})::double precision / 1000 end
          )
        else s.window_ended_at
      end
    when pg_input_is_valid(${snapshotSourceObserved}, 'timestamp with time zone')
      then (${snapshotSourceObserved})::timestamptz
    when pg_input_is_valid(nullif(s.data->>'scheduledFor', ''), 'timestamp with time zone')
      then (s.data->>'scheduledFor')::timestamptz
    else s.window_ended_at end`;
  // This expression is used inside an explicitly aliased raw CTE branch.
  // Do not interpolate Drizzle columns here: it renders the table name rather
  // than the `m` alias and PostgreSQL correctly rejects that reference.
  const measurementCategory = sql`case
    when m.measurement_kind = 'energy' then 'energy'
    when m.measurement_kind in ('electrical', 'active-power', 'dc-power') then 'electrical'
    when lower(m.parameter) ~ '(alarm|fault|trip|error|warning)' then 'alarms'
    when lower(m.parameter) ~ '(irradiance|temperature|humidity|wind|rain|weather|ambient|environment)' then 'environmental'
    when lower(m.parameter) ~ '(energy|yield|generation|kwh|mwh)' then 'energy'
    when lower(m.parameter) ~ '(voltage|current|amper|frequency|powerfactor|reactive|electrical|activepower|acpower|dcpower|realpower)' then 'electrical'
    when lower(m.parameter) ~ '(inverter|inv)' then 'inverter'
    else 'operations' end`;

  const base = sql`
    with snapshot_scope as (
      select s.*, max(s.captured_at) over () as latest_captured_at
      from ${mqttSnapshotsTable} s
      where s.topic = ${args.topic}
        and s.window_ended_at >= ${args.from} and s.window_started_at <= ${args.to}
        and ${args.siteName
          ? sql`exists (
              select 1
              from jsonb_array_elements(
                case when jsonb_typeof(s.data->'latestParameters') = 'array' then s.data->'latestParameters' else '[]'::jsonb end
              ) as scoped_parameter(value)
              where coalesce(
                nullif(scoped_parameter.value->>'site_name', ''),
                nullif(scoped_parameter.value->>'siteName', ''),
                nullif(scoped_parameter.value->>'plant_name', ''),
                nullif(scoped_parameter.value->>'plantName', ''),
                ${args.defaultSite}
              ) = ${args.siteName}
            )`
          : sql`true`}
    ),
    all_records as (
      select
        ('measurement|' || m.id)::text as id, 'measurement'::text as record_type,
        ${measurementCategory}::text as category, m.site_name, m.inverter_id as device_id,
        m.inverter_name as device_name, m.parameter, m.display_label, m.measurement_kind,
        m.value, m.unit, m.address, m.source_name, m.observed_at, m.received_at,
        'historical-saved'::text as provenance,
        case when m.scaling_status = 'validated' then 'validated' else 'raw' end::text as quality,
        null::text as status, null::text as reason,
        null::text as source_reported_value, null::text as source_reported_unit,
        m.raw_value::text as transport_raw_value, null::text as source_identity
      from ${mqttInverterMeasurementHistoryTable} m
      where m.topic = ${args.topic} and m.observed_at >= ${args.from} and m.observed_at <= ${args.to}
      union all
      select
        ('energy|' || e.id)::text, 'energy', 'energy', e.site_name, e.inverter_id,
        e.inverter_name, e.parameter, e.parameter, 'energy', e.value, e.unit, e.address,
        e.source_name, e.observed_at, e.received_at, 'historical-saved',
        case when e.scaling_status = 'validated' then 'validated' else 'raw' end,
        null::text, null::text,
        null::text, null::text, e.raw_value::text, null::text
      from ${mqttInverterEnergyHistoryTable} e
      where e.topic = ${args.topic} and e.observed_at >= ${args.from} and e.observed_at <= ${args.to}
      union all
      select
        ('communication|' || c.id)::text, 'communication', 'communication',
        ${args.defaultSite}, null::text, null::text, c.event_type, 'Communication event',
        'communication', c.duration_ms::double precision,
        case when c.duration_ms is null then '' else 'ms' end, '—',
        'MQTT delivery evidence', c.received_at, c.received_at, 'historical-saved',
        'source-reported',
        case when c.event_type like '%gap%' or c.event_type like '%interrupt%' then 'warning' else null end,
        c.reason,
        null::text, null::text, c.raw_payload, null::text
      from ${mqttCommunicationEventsTable} c
      where c.topic = ${args.topic} and c.received_at >= ${args.from} and c.received_at <= ${args.to}
        and ${args.siteName ? sql`false` : sql`true`}
      ${args.liveRecord ? sql`
      union all
      select
        ${args.liveRecord.id}::text, ${args.liveRecord.recordType}::text,
        ${args.liveRecord.category}::text, ${args.liveRecord.siteName}::text,
        ${args.liveRecord.deviceId}::text, ${args.liveRecord.deviceName}::text,
        ${args.liveRecord.parameter}::text, ${args.liveRecord.displayLabel}::text,
        ${args.liveRecord.measurementKind ?? "other"}::text,
        ${args.liveRecord.value}::double precision, ${args.liveRecord.unit}::text,
        ${args.liveRecord.address}::text, ${args.liveRecord.sourceName}::text,
        ${new Date(args.liveRecord.observedAt)}::timestamptz,
        ${new Date(args.liveRecord.receivedAt)}::timestamptz,
        'live'::text, ${args.liveRecord.quality}::text,
        ${args.liveRecord.status}::text, ${args.liveRecord.reason}::text,
        ${args.liveRecord.sourceReportedValue ?? null}::text,
        ${args.liveRecord.sourceReportedUnit ?? null}::text,
        ${args.liveRecord.transportRawValue ?? null}::text,
        ${args.liveRecord.sourceIdentity ?? null}::text
      ` : sql``}
      union all
      select
        ('snapshot|' || s.id || '|' || p.ordinality)::text, 
        case when ${snapshotCategory} = 'alarms' then 'alarm' else 'snapshot' end,
        ${snapshotCategory}, ${snapshotSite},
        coalesce(nullif(p.value->>'inverter_id', ''), nullif(p.value->>'inverterId', ''), nullif(p.value->>'device_id', ''), nullif(p.value->>'deviceId', '')),
        coalesce(nullif(p.value->>'inverter_name', ''), nullif(p.value->>'inverterName', ''), nullif(p.value->>'device_name', ''), nullif(p.value->>'deviceName', '')),
        ${snapshotParameter},
        coalesce(nullif(p.value->>'display_name', ''), nullif(p.value->>'displayName', ''), nullif(p.value->>'label', ''), ${snapshotParameter}),
        'snapshot',
        case when ${snapshotCategory} = 'alarms' then null
             when lower(${snapshotValidated}) in ('true', 'validated', 'confirmed', 'approved')
               and coalesce(p.value->>'data', '') ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' then (p.value->>'data')::double precision
             else null end,
        case when ${snapshotCategory} = 'alarms' then ''
             when lower(${snapshotValidated}) in ('true', 'validated', 'confirmed', 'approved') then coalesce(p.value->>'engineering_unit', p.value->>'unit', 'source units')
             else '' end,
        coalesce(p.value->>'full_addr', p.value->>'address', p.value->>'addr', '—'),
        coalesce(p.value->>'server_name', p.value->>'source', 'Saved MQTT snapshot'),
        ${snapshotObserved},
        s.captured_at,
        case when s.captured_at = s.latest_captured_at then 'latest-saved' else 'historical-saved' end,
        case when ${snapshotCategory} = 'alarms' then 'source-reported'
             when lower(${snapshotValidated}) in ('true', 'validated', 'confirmed', 'approved') then 'validated'
              when p.value->>'source_mapping_status' = 'source-reported' then 'source-reported'
             else 'raw' end,
        coalesce(p.value->>'alarmStatus', p.value->>'alarm_status', p.value->>'status', p.value->>'state', p.value->>'severity'),
        case when ${snapshotCategory} = 'alarms'
             then coalesce(p.value->>'reason', p.value->>'description', p.value->>'message', p.value->>'cause', 'Source-reported alarm/fault evidence.')
              else null end,
        coalesce(p.value->>'reported_value', p.value->>'reportedValue', p.value->>'customer_value', p.value->>'customerValue'),
        coalesce(p.value->>'reported_unit', p.value->>'reportedUnit', p.value->>'customer_unit', p.value->>'customerUnit', p.value->>'source_unit', p.value->>'sourceUnit'),
        coalesce(p.value->>'raw_data', p.value->>'rawValue', p.value->>'raw_value', p.value->>'source_raw_value', p.value->>'sourceRawValue'),
        coalesce(p.value->>'source_identity', p.value->>'sourceIdentity')
      from snapshot_scope s
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(s.data->'latestParameters') = 'array' then s.data->'latestParameters' else '[]'::jsonb end
      ) with ordinality p(value, ordinality)
      where coalesce(s.data->>'saveStatus',
        case when s.message_count = 0 then 'missing' when s.parameter_count = 0 then 'incomplete' else 'saved' end) = 'saved'
        and ${snapshotObserved} >= ${args.from} and ${snapshotObserved} <= ${args.to}
    ),
    candidate_records as (
      select * from all_records
      where observed_at >= ${args.from} and observed_at <= ${args.to}
        and (${args.siteName === "" ? sql`true` : sql`site_name = ${args.siteName}`})
        and ${listCondition(sql`coalesce(device_id, device_name)`, args.filters.devices)}
        and ${listCondition(sql`parameter`, args.filters.parameters)}
        and ${args.filters.provenance.length ? listCondition(sql`provenance`, args.filters.provenance) : sql`true`}
        and ${args.filters.status === "all" ? sql`true` : sql`status = ${args.filters.status}`}
        and ${reportTypeCondition(args.reportType)}
    ),
    filtered_records as (
      select * from candidate_records
      where quality <> 'raw'
        and ${args.filters.quality === "all" ? sql`true` : sql`quality = ${args.filters.quality}`}
    )`;
  return base;
}

function asIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRecord(row: RecordRow): ScadaReportRecord {
  return {
    ...row,
    recordType: row.recordType,
    category: row.category,
    observedAt: asIso(row.observedAt),
    receivedAt: asIso(row.receivedAt),
  };
}

export async function queryBoundedScadaReport(args: QueryArgs) {
  const base = cte(args);
  const offset = (args.page - 1) * args.pageSize;
  const [countResult, pageResult, chartResult] = await Promise.all([
    db.execute(sql`${base}
      select count(*)::integer as total_records,
        count(*) filter (where quality = 'validated')::integer as validated_records,
        count(*) filter (where quality = 'source-reported')::integer as source_reported_records,
        count(distinct device_id) filter (where device_id is not null)::integer as unique_devices,
        count(*) filter (where record_type = 'alarm')::integer as alarms,
        count(*) filter (where record_type = 'alarm' and status = 'active')::integer as active_alarms,
        count(*) filter (where record_type = 'communication')::integer as communication_events,
        count(*) filter (where record_type = 'communication' and status = 'warning')::integer as communication_warnings,
        (select count(*)::integer from candidate_records where quality = 'raw') as excluded_raw,
        (select count(*)::integer from snapshot_scope
          where coalesce(data->>'saveStatus',
            case when message_count = 0 then 'missing' when parameter_count = 0 then 'incomplete' else 'saved' end) <> 'saved') as excluded_snapshots,
        max(observed_at) as latest_observed_at, max(received_at) as latest_received_at
      from filtered_records`),
    db.execute(sql`${base}
      select id, record_type as "recordType", category, site_name as "siteName",
        device_id as "deviceId", device_name as "deviceName", parameter,
        display_label as "displayLabel", measurement_kind as "measurementKind",
        value, unit, address, source_name as "sourceName", observed_at as "observedAt",
         received_at as "receivedAt", provenance, quality, status, reason,
         source_reported_value as "sourceReportedValue", source_reported_unit as "sourceReportedUnit",
         transport_raw_value as "transportRawValue", source_identity as "sourceIdentity"
      from filtered_records
      order by observed_at desc, received_at desc, record_type asc, id asc
      limit ${args.pageSize} offset ${offset}`),
    db.execute(sql`${base}
      select id, record_type as "recordType", category, site_name as "siteName",
        device_id as "deviceId", device_name as "deviceName", parameter,
        display_label as "displayLabel", measurement_kind as "measurementKind",
        value, unit, address, source_name as "sourceName", observed_at as "observedAt",
         received_at as "receivedAt", provenance, quality, status, reason,
         source_reported_value as "sourceReportedValue", source_reported_unit as "sourceReportedUnit",
         transport_raw_value as "transportRawValue", source_identity as "sourceIdentity"
      from filtered_records
      where quality = 'validated' and value is not null
      order by observed_at desc, received_at desc, record_type asc, id asc
      limit 480`),
  ]);
  return {
    aggregate: countResult.rows[0] as Record<string, unknown>,
    records: (pageResult.rows as unknown as RecordRow[]).map(mapRecord),
    chartRecords: (chartResult.rows as unknown as RecordRow[]).map(mapRecord),
  };
}