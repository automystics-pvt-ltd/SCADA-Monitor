import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const mqttDeliverySequencesTable = pgTable("mqtt_delivery_sequences", {
  topic: text("topic").primaryKey(),
  nextSequence: bigint("next_sequence", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mqttConsumerLeasesTable = pgTable("mqtt_consumer_leases", {
  topic: text("topic").primaryKey(),
  ownerId: text("owner_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});