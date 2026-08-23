import { pgTable, serial, timestamp, text, integer, jsonb } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const mqttSnapshots = pgTable("mqtt_snapshots", {
	id: serial().primaryKey().notNull(),
	windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: 'string' }).notNull(),
	windowEndedAt: timestamp("window_ended_at", { withTimezone: true, mode: 'string' }).notNull(),
	capturedAt: timestamp("captured_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	topic: text().notNull(),
	messageCount: integer("message_count").notNull(),
	parameterCount: integer("parameter_count").notNull(),
	data: jsonb().notNull(),
});
