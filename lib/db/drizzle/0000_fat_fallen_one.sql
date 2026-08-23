-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "mqtt_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"window_ended_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"topic" text NOT NULL,
	"message_count" integer NOT NULL,
	"parameter_count" integer NOT NULL,
	"data" jsonb NOT NULL
);

*/