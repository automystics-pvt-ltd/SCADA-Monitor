import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const mqttSnapshotsTable = pgTable("mqtt_snapshots", {
  id: serial("id").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  windowEndedAt: timestamp("window_ended_at", { withTimezone: true }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  topic: text("topic").notNull(),
  messageCount: integer("message_count").notNull(),
  parameterCount: integer("parameter_count").notNull(),
  data: jsonb("data").notNull(),
}, (table) => [
  uniqueIndex("mqtt_snapshot_topic_window_ended_unique")
    .on(table.topic, table.windowEndedAt)
    .where(sql`(${table.data} ->> 'schemaVersion') = '3'`),
]);

export const insertMqttSnapshotSchema = createInsertSchema(mqttSnapshotsTable).omit({ id: true, capturedAt: true });
export type InsertMqttSnapshot = z.infer<typeof insertMqttSnapshotSchema>;
export type MqttSnapshot = typeof mqttSnapshotsTable.$inferSelect;