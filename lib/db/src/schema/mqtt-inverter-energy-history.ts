import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { doublePrecision, index, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const mqttInverterEnergyHistoryTable = pgTable("mqtt_inverter_energy_history", {
  id: serial("id").primaryKey(),
  topic: text("topic").notNull(),
  siteName: text("site_name").notNull(),
  inverterId: text("inverter_id").notNull(),
  inverterName: text("inverter_name").notNull(),
  parameter: text("parameter").notNull(),
  value: doublePrecision("value").notNull(),
  rawValue: text("raw_value").notNull(),
  unit: text("unit").notNull(),
  address: text("address").notNull(),
  sourceName: text("source_name").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  scalingStatus: text("scaling_status").notNull().default("raw"),
  sourcePayload: text("source_payload").notNull(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
}, (table) => [
  index("mqtt_inverter_energy_history_scope_observed_idx").on(table.siteName, table.inverterId, table.observedAt),
  uniqueIndex("mqtt_inverter_energy_history_sample_unique").on(table.siteName, table.topic, table.inverterId, table.parameter, table.address, table.observedAt),
]);

export const insertMqttInverterEnergyHistorySchema = createInsertSchema(mqttInverterEnergyHistoryTable).omit({ id: true });
export type InsertMqttInverterEnergyHistory = z.infer<typeof insertMqttInverterEnergyHistorySchema>;
export type MqttInverterEnergyHistory = typeof mqttInverterEnergyHistoryTable.$inferSelect;