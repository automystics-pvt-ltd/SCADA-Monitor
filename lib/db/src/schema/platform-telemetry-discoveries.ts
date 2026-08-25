import { sql } from "drizzle-orm";
import { doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

/**
 * Durable latest evidence for every source signal the platform has observed.
 * This is deliberately a catalog of evidence rather than a semantic map:
 * mappings are joined by their exact identity at read/ingest time.
 */
export const platformTelemetryDiscoveriesTable = pgTable(
  "platform_telemetry_discoveries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Evidence can arrive before it has an unambiguous managed-site assignment.
    // Keep that source identity catalogued rather than dropping it at ingestion;
    // access-controlled mapping reads still select only managed site names.
    siteName: varchar("site_name", { length: 160 }).notNull(),
    deviceId: varchar("device_id", { length: 160 }).notNull(),
    deviceName: varchar("device_name", { length: 240 }).notNull(),
    topic: text("topic").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    sourceName: varchar("source_name", { length: 160 }).notNull(),
    originalName: varchar("original_name", { length: 240 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 240 }).notNull(),
    address: varchar("address", { length: 240 }).notNull().default("—"),
    rawValue: text("raw_value").notNull(),
    reportedValue: text("reported_value").notNull(),
    reportedNumericValue: doublePrecision("reported_numeric_value"),
    sourceUnit: varchar("source_unit", { length: 80 }),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    provenance: varchar("provenance", { enum: ["live", "retained", "recovered", "replay", "snapshot"] }).notNull(),
    sourceMappingStatus: varchar("source_mapping_status", { enum: ["source-reported", "raw"] }).notNull(),
    dataQuality: varchar("data_quality", { enum: ["validated", "raw", "source-reported"] }).notNull(),
    scalingStatus: varchar("scaling_status", { enum: ["validated", "raw"] }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    observationCount: integer("observation_count").notNull().default(1),
    mappingStatus: varchar("mapping_status", { enum: ["unmapped", "mapped"] }).notNull().default("unmapped"),
    lastMappingChangedAt: timestamp("last_mapping_changed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("platform_telemetry_discovery_identity_unique").on(
      table.siteName, table.deviceId, table.sourceIdentity, table.normalizedName, table.address,
    ),
    index("platform_telemetry_discovery_site_device_index").on(table.siteName, table.deviceId),
    index("platform_telemetry_discovery_last_seen_index").on(table.siteName, table.lastSeenAt),
    index("platform_telemetry_discovery_unmapped_queue_index").on(table.siteName, table.mappingStatus, table.lastSeenAt),
  ],
);

export type PlatformTelemetryDiscovery = typeof platformTelemetryDiscoveriesTable.$inferSelect;