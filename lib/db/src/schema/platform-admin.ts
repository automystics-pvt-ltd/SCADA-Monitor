import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

export const platformAdminIdentitiesTable = pgTable(
  "platform_admin_identities",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    role: varchar("role", { enum: ["super-admin", "admin"] }).notNull().default("admin"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("platform_admin_identities_user_unique").on(table.userId)],
);

export const platformAdminSessionsTable = pgTable(
  "platform_admin_sessions",
  {
    sid: varchar("sid").primaryKey(),
    adminIdentityId: varchar("admin_identity_id").notNull().references(() => platformAdminIdentitiesTable.id, { onDelete: "cascade" }),
    expire: timestamp("expire", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("platform_admin_sessions_expire_index").on(table.expire)],
);

export const platformOrganizationsTable = pgTable(
  "platform_organizations",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    status: varchar("status", { enum: ["active", "archived"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("platform_organizations_slug_unique").on(table.slug)],
);

export const platformSitesTable = pgTable(
  "platform_sites",
  {
    siteName: varchar("site_name", { length: 160 }).primaryKey(),
    organizationId: varchar("organization_id").notNull().references(() => platformOrganizationsTable.id, { onDelete: "restrict" }),
    timezone: varchar("timezone", { length: 80 }).notNull().default("UTC"),
    status: varchar("status", { enum: ["active", "archived"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [index("platform_sites_organization_index").on(table.organizationId)],
);

export const platformSiteAccessTable = pgTable(
  "platform_site_access",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    siteName: varchar("site_name", { length: 160 }).notNull().references(() => platformSitesTable.siteName, { onDelete: "cascade" }),
    role: varchar("role", { enum: ["viewer", "operator", "site-admin"] }).notNull().default("viewer"),
    status: varchar("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("platform_site_access_user_site_unique").on(table.userId, table.siteName),
    index("platform_site_access_site_index").on(table.siteName),
  ],
);

export const platformConfigurationTable = pgTable("platform_configuration", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: varchar("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const platformAuditEventsTable = pgTable(
  "platform_audit_events",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    actorUserId: varchar("actor_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
    actorEmail: varchar("actor_email", { length: 320 }).notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 80 }).notNull(),
    targetId: varchar("target_id", { length: 160 }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("platform_audit_events_created_index").on(table.createdAt)],
);

export const insertPlatformOrganizationSchema = createInsertSchema(platformOrganizationsTable).omit({ id: true, status: true, createdAt: true, updatedAt: true });
export const insertPlatformSiteSchema = createInsertSchema(platformSitesTable).omit({ status: true, createdAt: true, updatedAt: true });
export type PlatformOrganization = typeof platformOrganizationsTable.$inferSelect;
export type PlatformSite = typeof platformSitesTable.$inferSelect;
export type PlatformSiteAccess = typeof platformSiteAccessTable.$inferSelect;
export type PlatformAuditEvent = typeof platformAuditEventsTable.$inferSelect;
export type InsertPlatformOrganization = z.infer<typeof insertPlatformOrganizationSchema>;
export type InsertPlatformSite = z.infer<typeof insertPlatformSiteSchema>;