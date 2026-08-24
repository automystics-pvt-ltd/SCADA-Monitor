CREATE TABLE "mqtt_consumer_leases" (
	"topic" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mqtt_delivery_sequences" (
	"topic" text PRIMARY KEY NOT NULL,
	"next_sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
