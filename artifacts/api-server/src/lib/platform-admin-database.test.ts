import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRestrictedReadOnlyQuery } from "./platform-admin-database";

test("accepts a wildcard select against an approved table regardless of case", async () => {
  const parsed = await parseRestrictedReadOnlyQuery("select * from Users");
  assert.equal(parsed.table.name, "users");
  assert.deepEqual(parsed.columns, ["*"]);
});

test("accepts a wildcard select with an explicit numeric limit", async () => {
  const parsed = await parseRestrictedReadOnlyQuery("select * from users limit 10");
  assert.equal(parsed.limit, 10);
});

test("accepts an explicit column list", async () => {
  const parsed = await parseRestrictedReadOnlyQuery("select id, email from users");
  assert.deepEqual(parsed.columns, ["id", "email"]);
});

test("rejects queries against tables outside the approved list", async () => {
  await assert.rejects(() => parseRestrictedReadOnlyQuery("select * from pg_catalog.pg_user"));
});

test("rejects multiple statements and comments", async () => {
  await assert.rejects(() => parseRestrictedReadOnlyQuery("select * from users; drop table users;"));
  await assert.rejects(() => parseRestrictedReadOnlyQuery("select * from users -- comment"));
});

test("rejects filters, joins, and functions", async () => {
  await assert.rejects(() => parseRestrictedReadOnlyQuery("select * from users where id = 1"));
  await assert.rejects(() => parseRestrictedReadOnlyQuery("select * from users join platform_sites on true"));
  await assert.rejects(() => parseRestrictedReadOnlyQuery("select count(*) from users"));
});
