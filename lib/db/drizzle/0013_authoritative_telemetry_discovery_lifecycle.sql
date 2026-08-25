ALTER TABLE "platform_telemetry_discoveries"
  ADD COLUMN "observation_count" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_telemetry_discoveries"
  ADD COLUMN "mapping_status" varchar(16) DEFAULT 'unmapped' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_telemetry_discoveries"
  ADD COLUMN "last_mapping_changed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "platform_telemetry_discovery_unmapped_queue_index"
  ON "platform_telemetry_discoveries" USING btree ("site_name", "mapping_status", "last_seen_at");
--> statement-breakpoint
UPDATE "platform_telemetry_discoveries" AS discovery
SET
  "mapping_status" = 'mapped',
  "last_mapping_changed_at" = mapping."updated_at"
FROM "platform_telemetry_mappings" AS mapping
WHERE mapping."status" = 'active'
  AND mapping."site_name" = discovery."site_name"
  AND mapping."device_id" = discovery."device_id"
  AND mapping."source_identity" = discovery."source_identity"
  AND mapping."normalized_name" = discovery."normalized_name"
  AND mapping."address" = discovery."address";