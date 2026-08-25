CREATE TABLE "scada_sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"expire" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admin_otp_challenges" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_telemetry_mappings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_name" varchar(160) NOT NULL,
	"device_id" varchar(160) NOT NULL,
	"source_identity" text NOT NULL,
	"source_name" varchar(160) NOT NULL,
	"normalized_name" varchar(240) NOT NULL,
	"address" varchar(240) DEFAULT '—' NOT NULL,
	"destination" varchar NOT NULL,
	"display_label" varchar(240) NOT NULL,
	"category" varchar(120) NOT NULL,
	"inverter_identity" varchar(80),
	"source_unit" varchar(80),
	"status" varchar DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" varchar NOT NULL,
	"updated_by" varchar NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plant_calibration_profiles" ALTER COLUMN "installed_dc_capacity_kwp" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" varchar(64);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scada_sessions" ADD CONSTRAINT "scada_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_telemetry_mappings" ADD CONSTRAINT "platform_telemetry_mappings_site_name_platform_sites_site_name_fk" FOREIGN KEY ("site_name") REFERENCES "public"."platform_sites"("site_name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_telemetry_mappings" ADD CONSTRAINT "platform_telemetry_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_telemetry_mappings" ADD CONSTRAINT "platform_telemetry_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scada_sessions_expire_index" ON "scada_sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "scada_sessions_user_index" ON "scada_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_admin_otp_email_created_index" ON "platform_admin_otp_challenges" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "platform_admin_otp_expire_index" ON "platform_admin_otp_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_telemetry_mapping_identity_unique" ON "platform_telemetry_mappings" USING btree ("site_name","device_id","source_identity","normalized_name","address");--> statement-breakpoint
CREATE INDEX "platform_telemetry_mapping_site_status_index" ON "platform_telemetry_mappings" USING btree ("site_name","status");--> statement-breakpoint
CREATE INDEX "platform_telemetry_mapping_site_device_index" ON "platform_telemetry_mappings" USING btree ("site_name","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_unique" ON "users" USING btree ("username");