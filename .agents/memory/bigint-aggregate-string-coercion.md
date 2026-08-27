---
name: bigint-aggregate-string-coercion
description: node-postgres/drizzle return a raw sql`max(bigint_column)` aggregate as a JS string, not a number, regardless of magnitude -- a silent trap for strict equality/comparison logic.
---

Postgres BIGINT columns come back from `pg` (and drizzle's `sql<...>` raw templates, which only carry a compile-time type assertion, not a runtime conversion) as JS **strings**, even for small values. `sql<number | null>`max(...)`` does not coerce anything at runtime.

**Why:** A downstream consumer that uses the value with a *coercing* operator (`Math.max()`, `<`, `<=`) will accidentally work, masking the bug. A consumer that uses **strict equality** (`!==`, `===`) against a real JS number will get a silent, permanent false result -- e.g. this broke a standby delivery-recovery loop into always reporting a spurious gap and never delivering the recovered data, with no visible error.

**How to apply:** Whenever reading a `sql\`max(...)\`` (or `sum`, `count` on a bigint column) aggregate, coerce explicitly with `Number(...)` (or `parseInt`) once, right at the query boundary, before the value is used anywhere with strict equality. Don't trust the TS return-type annotation on `sql<T>` -- it is not enforced at runtime. When debugging a replay/reconciliation loop that always detects "a gap" even for contiguous data, suspect a string-vs-number mismatch in a delivery-sequence/high-water comparison first.
