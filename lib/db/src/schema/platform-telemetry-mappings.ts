import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { platformSitesTable } from "./platform-admin";

/**
 * A semantic/display map for one source-reported signal. This deliberately
 * contains no multiplier or engineering conversion: calibration profiles stay
 * the only route by which raw evidence becomes a verified KPI.
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