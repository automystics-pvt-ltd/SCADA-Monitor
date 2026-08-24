import { createInsertSchema } from "drizzle-zod";
import { doublePrecision, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const plantCalibrationProfilesTable = pgTable("plant_calibration_profiles", {
  id: serial("id").primaryKey(),
  siteName: text("site_name").notNull(),
  version: text("version").notNull(),
  status: text("status").notNull().default("approved"),
  installedDcCapacityKwp: doublePrecision("installed_dc_capacity_kwp").notNull(),
  sources: jsonb("sources").notNull(),
  approvedBy: text("approved_by").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("plant_calibration_profiles_site_unique").on(table.siteName),
]);

export const insertPlantCalibrationProfileSchema = createInsertSchema(plantCalibrationProfilesTable).omit({ id: true, approvedAt: true, updatedAt: true });
export type InsertPlantCalibrationProfile = z.infer<typeof insertPlantCalibrationProfileSchema>;
export type PlantCalibrationProfile = typeof plantCalibrationProfilesTable.$inferSelect;