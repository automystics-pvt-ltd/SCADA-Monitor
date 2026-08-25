import { sql } from "drizzle-orm";
import { doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { platformSitesTable } from "./platform-admin";

/**
 * The approved display contract for one exact device signal. Raw transport and
 * source-reported evidence never change; the linear transform produces a
 * separate customer-facing display value. Plant calibration profiles remain
 * the authority for derived engineering KPIs and energy calculations.
 */
export const platformTelemetryMappingsTable = pgTable(
  "platform_telemetry_mappings",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    siteName: varchar("site_name", { length: 160 }).notNull().references(() => platformSitesTable.siteName, { onDelete: "cascade" }),
    deviceId: varchar("device_id", { length: 160 }).notNull(),
    sourceIdentity: text("source_identity").notNull(),
    sourceName: varchar("source_name", { length: 160 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 240 }).notNull(),
    address: varchar("address", { length: 240 }).notNull().default("—"),
    destination: varchar("destination", {
      enum: [
        "inverter-identity", "active-power", "daily-energy", "total-energy", "specific-yield",
        "voltage", "current", "frequency", "environmental", "alarm", "fault",
        "communication", "data-quality", "discovered-other",
      ],
    }).notNull(),
    displayLabel: varchar("display_label", { length: 240 }).notNull(),
    category: varchar("category", { length: 120 }).notNull(),
    inverterIdentity: varchar("inverter_identity", { length: 80 }),
    sourceUnit: varchar("source_unit", { length: 80 }),
    displayUnit: varchar("display_unit", { length: 80 }),
    scalingMultiplier: doublePrecision("scaling_multiplier").notNull().default(1),
    scalingOffset: doublePrecision("scaling_offset").notNull().default(0),
    scalingStatus: varchar("scaling_status", { enum: ["approved"] }).notNull().default("approved"),
    status: varchar("status", { enum: ["active", "cleared"] }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdBy: varchar("created_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    updatedBy: varchar("updated_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("platform_telemetry_mapping_identity_unique").on(
      table.siteName,
      table.deviceId,
      table.sourceIdentity,
      table.normalizedName,
      table.address,
    ),
    index("platform_telemetry_mapping_site_status_index").on(table.siteName, table.status),
    index("platform_telemetry_mapping_site_device_index").on(table.siteName, table.deviceId),
  ],
);

export const insertPlatformTelemetryMappingSchema = createInsertSchema(platformTelemetryMappingsTable)
  .omit({ id: true, version: true, clearedAt: true, createdAt: true, updatedAt: true });
export type InsertPlatformTelemetryMapping = z.infer<typeof insertPlatformTelemetryMappingSchema>;
export type PlatformTelemetryMapping = typeof platformTelemetryMappingsTable.$inferSelect;