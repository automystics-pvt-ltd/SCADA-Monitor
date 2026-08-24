import { createInsertSchema } from "drizzle-zod";
import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const plantLocationsTable = pgTable("plant_locations", {
  siteName: text("site_name").primaryKey(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPlantLocationSchema = createInsertSchema(plantLocationsTable).omit({ updatedAt: true });
export type InsertPlantLocation = z.infer<typeof insertPlantLocationSchema>;
export type PlantLocation = typeof plantLocationsTable.$inferSelect;