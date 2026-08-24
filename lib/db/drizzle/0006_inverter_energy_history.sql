CREATE TABLE "mqtt_inverter_energy_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "topic" text NOT NULL,
  "site_name" text NOT NULL,
  "inverter_id" text NOT NULL,
  "inverter_name" text NOT NULL,
  "parameter" text NOT NULL,
  "value" double precision NOT NULL,
  "raw_value" text NOT NULL,
  "unit" text NOT NULL,
  "address" text NOT NULL,
  "source_name" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "scaling_status" text DEFAULT 'raw' NOT NULL,
  "source_payload" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mqtt_inverter_energy_history_scope_observed_idx" ON "mqtt_inverter_energy_history" USING btree ("site_name","inverter_id","observed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "mqtt_inverter_energy_history_sample_unique" ON "mqtt_inverter_energy_history" USING btree ("site_name","topic","inverter_id","parameter","address","observed_at");