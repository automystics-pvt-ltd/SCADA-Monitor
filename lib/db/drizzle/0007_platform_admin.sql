CREATE TABLE "platform_admin_identities" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"role" varchar DEFAULT 'admin' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admin_sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"admin_identity_id" varchar NOT NULL,
	"expire" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_audit_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" varchar NOT NULL,
	"actor_email" varchar(320) NOT NULL,
	"action" varchar(120) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" varchar(160) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_configuration" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" varchar,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_organizations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"slug" varchar(80) NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_site_access" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"site_name" varchar(160) NOT NULL,
	"role" varchar DEFAULT 'viewer' NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_sites" (
	"site_name" varchar(160) PRIMARY KEY NOT NULL,
	"organization_id" varchar NOT NULL,
	"timezone" varchar(80) DEFAULT 'UTC' NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_admin_identities" ADD CONSTRAINT "platform_admin_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_admin_sessions" ADD CONSTRAINT "platform_admin_sessions_admin_identity_id_platform_admin_identities_id_fk" FOREIGN KEY ("admin_identity_id") REFERENCES "public"."platform_admin_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_configuration" ADD CONSTRAINT "platform_configuration_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_site_access" ADD CONSTRAINT "platform_site_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_site_access" ADD CONSTRAINT "platform_site_access_site_name_platform_sites_site_name_fk" FOREIGN KEY ("site_name") REFERENCES "public"."platform_sites"("site_name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sites" ADD CONSTRAINT "platform_sites_organization_id_platform_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."platform_organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admin_identities_user_unique" ON "platform_admin_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_admin_sessions_expire_index" ON "platform_admin_sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "platform_audit_events_created_index" ON "platform_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_organizations_slug_unique" ON "platform_organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_site_access_user_site_unique" ON "platform_site_access" USING btree ("user_id","site_name");--> statement-breakpoint
CREATE INDEX "platform_site_access_site_index" ON "platform_site_access" USING btree ("site_name");--> statement-breakpoint
CREATE INDEX "platform_sites_organization_index" ON "platform_sites" USING btree ("organization_id");