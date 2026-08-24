import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const mqttCommunicationEventsTable = pgTable("mqtt_communication_events", {
  id: serial("id").primaryKey(),
  deliverySequence: bigint("delivery_sequence", { mode: "number" }),
  topic: text("topic").notNull(),
  eventType: text("event_type").notNull(),
  rawPayload: text("raw_payload"),
  sourceTimestamp: text("source_timestamp"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  reason: text("reason"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
}, (table) => [
  index("mqtt_communication_events_topic_received_idx").on(table.topic, table.receivedAt),
  index("mqtt_communication_events_type_received_idx").on(table.eventType, table.receivedAt),
]);

export const insertMqttCommunicationEventSchema = createInsertSchema(mqttCommunicationEventsTable).omit({ id: true });
export type InsertMqttCommunicationEvent = z.infer<typeof insertMqttCommunicationEventSchema>;
export type MqttCommunicationEvent = typeof mqttCommunicationEventsTable.$inferSelect;