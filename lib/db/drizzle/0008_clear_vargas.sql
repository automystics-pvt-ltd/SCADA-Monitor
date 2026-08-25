CREATE TABLE "platform_telemetry_tests" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_name" varchar(160) NOT NULL,
	"device_id" varchar(160) NOT NULL,
	"device_name" varchar(160) NOT NULL,
	"result" varchar NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"timeout_seconds" integer NOT NULL,
	"broker_status" varchar(40) NOT NULL,
	"subscription_status" varchar(40) NOT NULL,
	"device_status" varchar(40) NOT NULL,
	"last_received_at" timestamp with time zone,
	"data_frequency_seconds" double precision,
	"actual_value" text,
	"data_quality" varchar(40) NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"communication_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_sites" ADD COLUMN "activation_status" varchar DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_sites" ADD COLUMN "activation_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_sites" ADD COLUMN "activation_updated_by" varchar;--> statement-breakpoint
ALTER TABLE "platform_telemetry_tests" ADD CONSTRAINT "platform_telemetry_tests_site_name_platform_sites_site_name_fk" FOREIGN KEY ("site_name") REFERENCES "public"."platform_sites"("site_name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_telemetry_tests" ADD CONSTRAINT "platform_telemetry_tests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_telemetry_tests_site_created_index" ON "platform_telemetry_tests" USING btree ("site_name","created_at");--> statement-breakpoint
CREATE INDEX "platform_telemetry_tests_site_result_index" ON "platform_telemetry_tests" USING btree ("site_name","result");--> statement-breakpoint
ALTER TABLE "platform_sites" ADD CONSTRAINT "platform_sites_activation_updated_by_users_id_fk" FOREIGN KEY ("activation_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;