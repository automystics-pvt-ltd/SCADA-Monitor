CREATE TABLE "mqtt_communication_events" (
"id" serial PRIMARY KEY NOT NULL,
"delivery_sequence" bigint,
"topic" text NOT NULL,
"event_type" text NOT NULL,
"raw_payload" text,
"source_timestamp" text,
"received_at" timestamp with time zone NOT NULL,
"started_at" timestamp with time zone,
"ended_at" timestamp with time zone,
"duration_ms" integer,
"reason" text,
"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mqtt_communication_events_topic_received_idx" ON "mqtt_communication_events" USING btree ("topic","received_at");--> statement-breakpoint
CREATE INDEX "mqtt_communication_events_type_received_idx" ON "mqtt_communication_events" USING btree ("event_type","received_at");