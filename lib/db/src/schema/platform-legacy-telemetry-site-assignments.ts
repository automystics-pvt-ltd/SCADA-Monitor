import { timestamp, pgTable, varchar } from "drizzle-orm/pg-core";
import { platformSitesTable } from "./platform-admin";

/**
 * Records, once and permanently, which managed site owns the historical
 * telemetry-catalog rows that were captured under a raw MQTT plant-site
 * default before that site's name was aligned with the configured plant
 * site. The assignment is established only while ownership is unambiguous
 * (exactly one active managed site differs from the raw default) and is
 * then durably persisted, so it keeps applying correctly even after the
 * plant expands to additional sites -- real or QA/test fixtures -- that
 * would otherwise make a live, count-based guess ambiguous or wrong.
 */
export const platformLegacyTelemetrySiteAssignmentsTable = pgTable("platform_legacy_telemetry_site_assignments", {
  // The literal siteName legacy discovery/mapping rows were filed under
  // before this managed site existed or was aligned with it (i.e. whatever
  // configuredMqttPlantSite was at the time).
  rawSiteName: varchar("raw_site_name", { length: 160 }).primaryKey(),
  managedSiteName: varchar("managed_site_name", { length: 160 })
    .notNull()
    .references(() => platformSitesTable.siteName, { onDelete: "cascade" }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PlatformLegacyTelemetrySiteAssignment = typeof platformLegacyTelemetrySiteAssignmentsTable.$inferSelect;
