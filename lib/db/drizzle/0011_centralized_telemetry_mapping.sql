ALTER TABLE "platform_telemetry_mappings" ADD COLUMN "display_unit" varchar(80);
--> statement-breakpoint
ALTER TABLE "platform_telemetry_mappings" ADD COLUMN "scaling_multiplier" double precision DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_telemetry_mappings" ADD COLUMN "scaling_offset" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_telemetry_mappings" ADD COLUMN "scaling_status" varchar DEFAULT 'approved' NOT NULL;
--> statement-breakpoint
CREATE TABLE "platform_telemetry_discoveries" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "site_name" varchar(160) NOT NULL,
  "device_id" varchar(160) NOT NULL,
  "device_name" varchar(240) NOT NULL,
  "topic" text NOT NULL,
  "source_identity" text NOT NULL,
  "source_name" varchar(160) NOT NULL,
  "original_name" varchar(240) NOT NULL,
  "normalized_name" varchar(240) NOT NULL,
  "address" varchar(240) DEFAULT '—' NOT NULL,
  "raw_value" text NOT NULL,
  "reported_value" text NOT NULL,
  "reported_numeric_value" double precision,
  "source_unit" varchar(80),
  "observed_at" timestamp with time zone,
  "received_at" timestamp with time zone NOT NULL,
  "provenance" varchar NOT NULL,
  "source_mapping_status" varchar NOT NULL,
  "data_quality" varchar NOT NULL,
  "scaling_status" varchar NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_telemetry_discovery_identity_unique" ON "platform_telemetry_discoveries" USING btree ("site_name","device_id","source_identity","normalized_name","address");
--> statement-breakpoint
CREATE INDEX "platform_telemetry_discovery_site_device_index" ON "platform_telemetry_discoveries" USING btree ("site_name","device_id");
--> statement-breakpoint
CREATE INDEX "platform_telemetry_discovery_last_seen_index" ON "platform_telemetry_discoveries" USING btree ("site_name","last_seen_at");