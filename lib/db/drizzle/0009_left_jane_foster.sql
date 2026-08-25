CREATE TABLE "platform_organization_access" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"organization_id" varchar NOT NULL,
	"status" varchar DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_status" varchar DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_organization_access" ADD CONSTRAINT "platform_organization_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_organization_access" ADD CONSTRAINT "platform_organization_access_organization_id_platform_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."platform_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_organization_access_user_org_unique" ON "platform_organization_access" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "platform_organization_access_org_index" ON "platform_organization_access" USING btree ("organization_id");--> statement-breakpoint
INSERT INTO "platform_organization_access" ("user_id", "organization_id", "status")
SELECT DISTINCT "platform_site_access"."user_id", "platform_sites"."organization_id", "platform_site_access"."status"
FROM "platform_site_access"
INNER JOIN "platform_sites" ON "platform_site_access"."site_name" = "platform_sites"."site_name"
ON CONFLICT ("user_id", "organization_id") DO NOTHING;