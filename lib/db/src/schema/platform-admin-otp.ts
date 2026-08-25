import { sql } from "drizzle-orm";
import { index, integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const platformAdminOtpChallengesTable = pgTable(
  "platform_admin_otp_challenges",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 128 }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("platform_admin_otp_email_created_index").on(table.email, table.createdAt),
    index("platform_admin_otp_expire_index").on(table.expiresAt),
  ],
);