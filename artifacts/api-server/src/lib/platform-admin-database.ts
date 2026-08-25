import crypto from "crypto";
import { pool } from "@workspace/db";

const MAX_BROWSE_ROWS = 200;
const MAX_BACKUP_ROWS_PER_TABLE = 2_000;
const MAX_QUERY_ROWS = 200;
const QUERY_TIMEOUT_MS = 5_000;

type ApprovedTable = {
  name: string;
  label: string;
  description: string;
};

const approvedTables: ApprovedTable[] = [
  { name: "platform_organizations", label: "Organizations", description: "Platform organization records and lifecycle status." },
  { name: "platform_sites", label: "Managed sites", description: "Approved plant/site identity, ownership, timezone, and status." },
  { name: "plant_locations", label: "Plant locations", description: "Centralized plant coordinates used by the approved site configuration." },
  { name: "users", label: "Users", description: "OIDC user profiles without session credentials." },
  { name: "platform_site_access", label: "Site access", description: "User-to-site roles and active/revoked access state." },
  { name: "platform_configuration", label: "Platform configuration", description: "Non-secret centrally staged platform configuration." },
  { name: "platform_audit_events", label: "Audit events", description: "Administrator action history and safely recorded metadata." },
  { name: "mqtt_inverter_energy_history", label: "Inverter energy history", description: "Persisted per-inverter energy evidence." },
  { name: "mqtt_inverter_measurement_history", label: "Inverter measurements", description: "Persisted per-inverter electrical measurements." },
  { name: "mqtt_communication_events", label: "Communication events", description: "Broker communication and delivery evidence." },
  { name: "mqtt_snapshots", label: "Saved telemetry snapshots", description: "Scheduled saved telemetry evidence." },
  { name: "plant_calibration_profiles", label: "Calibration profiles", description: "Approved source-register calibration profiles." },
];

const migrationManifest = [
  { name: "0000_fat_fallen_one", when: "1787497630504" },
  { name: "0001_curly_machine_man", when: "1787498886776" },
  { name: "0002_red_shadowcat", when: "1787499398199" },
  { name: "0003_idempotent-snapshot-window", when: "1787543918037" },
  { name: "0004_clever_squadron_supreme", when: "1787545824425" },
  { name: "0005_jazzy_terror", when: "1787546091592" },
  { name: "0006_inverter_energy_history", when: "1787547000000" },
  { name: "0007_platform_admin", when: "1787601706192" },
];

export type DatabaseColumn = { name: string; type: string; nullable: boolean };
export type DatabaseTable = ApprovedTable & { recordCount: number; columns: DatabaseColumn[] };

function quotedTable(name: string) {
  return `public."${name}"`;
}

function serializeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function approvedDatabaseTable(name: string) {
  return approvedTables.find((table) => table.name === name);
}

export function approvedDatabaseTableNames() {
  return approvedTables.map((table) => table.name);
}

async function tableColumns(tableName: string): Promise<DatabaseColumn[]> {
  const result = await pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
  }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return result.rows.map((column) => ({
    name: column.column_name,
    type: column.data_type,
    nullable: column.is_nullable === "YES",
  }));
}

export async function databaseTableDetails(table: ApprovedTable): Promise<DatabaseTable> {
  const [countResult, columns] = await Promise.all([
    pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quotedTable(table.name)}`),
    tableColumns(table.name),
  ]);
  return {
    ...table,
    recordCount: Number(countResult.rows[0]?.count ?? 0),
    columns,
  };
}

export async function listApprovedDatabaseTables() {
  return Promise.all(approvedTables.map((table) => databaseTableDetails(table)));
}

export async function browseApprovedDatabaseTable(input: {
  tableName: string;
  page: number;
  pageSize: number;
  search?: string;
}) {
  const table = approvedDatabaseTable(input.tableName);
  if (!table) throw new Error("Choose an approved application table.");
  const page = Number.isInteger(input.page) ? Math.max(input.page, 1) : 1;
  const pageSize = Number.isInteger(input.pageSize) ? Math.min(Math.max(input.pageSize, 1), MAX_BROWSE_ROWS) : 50;
  const search = input.search?.trim().slice(0, 80);
  const where = search ? "WHERE to_jsonb(record)::text ILIKE $1" : "";
  const offset = (page - 1) * pageSize;
  const values = search ? [`%${search}%`, pageSize, offset] : [pageSize, offset];
  const [tableDetails, countResult, rowsResult] = await Promise.all([
    databaseTableDetails(table),
    pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${quotedTable(table.name)} AS record ${where}`,
      search ? [`%${search}%`] : [],
    ),
    pool.query<{ row: unknown }>(
      `SELECT to_jsonb(record) AS row
       FROM ${quotedTable(table.name)} AS record
       ${where}
       ORDER BY record.ctid DESC
       LIMIT $${search ? 2 : 1} OFFSET $${search ? 3 : 2}`,
      values,
    ),
  ]);
  return {
    table: tableDetails,
    page,
    pageSize,
    totalRecords: Number(countResult.rows[0]?.count ?? 0),
    rows: rowsResult.rows.map((row) => serializeRecord(row.row)),
  };
}

export async function platformDatabaseHealth() {
  const startedAt = Date.now();
  try {
    const result = await pool.query<{ database: string; schema: string }>(
      "SELECT current_database() AS database, current_schema() AS schema",
    );
    return {
      status: "ok" as const,
      latencyMs: Date.now() - startedAt,
      database: result.rows[0]?.database ?? "application",
      schema: result.rows[0]?.schema ?? "public",
      checkedAt: new Date(),
    };
  } catch {
    return {
      status: "degraded" as const,
      latencyMs: Date.now() - startedAt,
      database: "application",
      schema: "public",
      checkedAt: new Date(),
      message: "The application database could not be reached.",
    };
  }
}

export async function platformMigrationStatus() {
  const expected = approvedDatabaseTableNames();
  const [tableResult, journalResult] = await Promise.all([
    pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [expected],
    ),
    pool.query<{ table_schema: string }>(
      `SELECT table_schema
       FROM information_schema.tables
       WHERE table_name = '__drizzle_migrations'
       ORDER BY table_schema
       LIMIT 1`,
    ),
  ]);
  const present = new Set(tableResult.rows.map((row) => row.table_name));
  const schemaReady = present.size === expected.length;
  const journalSchema = journalResult.rows[0]?.table_schema;
  const appliedMigrationTimes = new Set<string>();
  if (journalSchema && /^[a-z_][a-z0-9_]*$/i.test(journalSchema)) {
    const appliedResult = await pool.query<{ created_at: string }>(
      `SELECT created_at::text AS created_at FROM "${journalSchema}"."__drizzle_migrations"`,
    );
    for (const row of appliedResult.rows) appliedMigrationTimes.add(row.created_at);
  }
  const journalAvailable = Boolean(journalSchema);
  return {
    status: schemaReady && journalAvailable ? "ready" as const : "degraded" as const,
    latest: migrationManifest.at(-1)?.name ?? "unknown",
    expectedTables: expected.length,
    presentTables: present.size,
    migrations: migrationManifest.map((migration) => ({
      name: migration.name,
      status: journalAvailable
        ? (appliedMigrationTimes.has(migration.when) ? "present" as const : "missing" as const)
        : "available" as const,
    })),
    checkedAt: new Date(),
  };
}

export async function createApplicationBackup() {
  const tables = await Promise.all(approvedTables.map(async (table) => {
    const result = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(record) AS row FROM ${quotedTable(table.name)} AS record ORDER BY record.ctid DESC LIMIT $1`,
      [MAX_BACKUP_ROWS_PER_TABLE + 1],
    );
    const truncated = result.rows.length > MAX_BACKUP_ROWS_PER_TABLE;
    return {
      name: table.name,
      label: table.label,
      exportedRecords: Math.min(result.rows.length, MAX_BACKUP_ROWS_PER_TABLE),
      truncated,
      records: result.rows.slice(0, MAX_BACKUP_ROWS_PER_TABLE).map((row) => serializeRecord(row.row)),
    };
  }));
  return {
    generatedAt: new Date().toISOString(),
    format: "platform-application-data-export/v1",
    scope: "approved application tables only; session and credential tables are excluded",
    rowLimitPerTable: MAX_BACKUP_ROWS_PER_TABLE,
    tables,
  };
}

async function parseRestrictedReadOnlyQuery(query: string) {
  const normalized = query.trim();
  if (!/^select\b/i.test(normalized)) throw new Error("Only a SELECT query is allowed.");
  if (normalized.length > 5_000) throw new Error("Query must be 5,000 characters or fewer.");
  if (/[;$]|--|\/\*|\*\/|\\/.test(normalized)) {
    throw new Error("Query comments, delimiters, and multiple statements are not allowed.");
  }
  const match = /^select\s+(\*|(?:"?[a-z_][a-z0-9_]*"?\s*)(?:,\s*"?[a-z_][a-z0-9_]*"?\s*)*)from\s+"?([a-z_][a-z0-9_]*)"?\s*(?:limit\s+([0-9]{1,4}))?$/i.exec(normalized);
  if (!match) {
    throw new Error("Use SELECT columns FROM approved_table with an optional numeric LIMIT. Joins, filters, functions, and aliases are not allowed.");
  }
  const [, requestedColumns, tableName, requestedLimit] = match;
  const table = approvedDatabaseTable(tableName.toLowerCase());
  if (!table) throw new Error("Choose an approved application table.");
  const availableColumns = new Set((await tableColumns(table.name)).map((column) => column.name));
  const columns = requestedColumns === "*"
    ? ["*"]
    : requestedColumns.split(",").map((column) => column.trim().replaceAll('"', "").toLowerCase());
  if (columns.some((column) => !availableColumns.has(column))) {
    throw new Error("Query only columns exposed by the selected approved table.");
  }
  const limit = Math.min(Math.max(Number(requestedLimit ?? MAX_QUERY_ROWS), 1), MAX_QUERY_ROWS);
  return { normalized, table, columns, limit };
}

export async function runReadOnlyDatabaseQuery(query: string) {
  const parsed = await parseRestrictedReadOnlyQuery(query);
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${QUERY_TIMEOUT_MS}ms'`);
    const selection = parsed.columns[0] === "*" ? "*" : parsed.columns.map((column) => `"${column}"`).join(", ");
    const result = await client.query(`SELECT ${selection} FROM ${quotedTable(parsed.table.name)} LIMIT $1`, [parsed.limit]);
    await client.query("COMMIT");
    const rows = result.rows.map((row) => serializeRecord(row));
    return {
      columns: result.fields.map((field) => field.name),
      rows,
      rowCount: rows.length,
      truncated: false,
      durationMs: Date.now() - startedAt,
      queryFingerprint: crypto.createHash("sha256").update(parsed.normalized).digest("hex").slice(0, 16),
      queryLength: parsed.normalized.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && /statement timeout/i.test(error.message)) {
      throw new Error("The query exceeded the five-second safety limit.");
    }
    throw error;
  } finally {
    client.release();
  }
}