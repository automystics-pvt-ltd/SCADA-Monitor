---
name: Bounded report evidence queries
description: Correctness and performance rules for paged SCADA report previews.
---

Normal SCADA report previews must build page rows, totals, summaries, and bounded chart samples from the same database-filtered evidence relation before returning data to the client. Do not page independent source tables and merge their slices in application code.

**Why:** Independent table offsets create gaps, duplicates, and misleading cross-source totals; materializing all selected-period evidence in Node merely moves pagination to presentation and does not improve large-period latency.

**How to apply:** Keep screen review on a parameterized unified evidence query with deterministic ordering and SQL-level page/count/aggregate operations. Retain a separate, explicit complete-evidence path for audit exports, rather than letting preview pagination silently truncate exported records.

## The separate complete-evidence path must reuse the same query, not reimplement its logic

A "separate path for complete exports" is only safe if it is a thin unbounded call into the exact same evidence-producing function (e.g. the same SQL CTE) as the paged preview. If the complete path is instead a second, independently hand-written implementation (e.g. raw per-table queries assembled in application code) it will drift from the preview's business rules — admin mapping joins, scaling/validation logic, category classification — even when each path looks correct in isolation, because nobody keeps two duplicate implementations in lockstep as either one changes.

**Why:** found in production-shape code where the export path silently skipped admin-approved telemetry mapping overlays that the preview applied, so an export could have different row counts/values/quality labels than what the operator saw on screen for identical filters — undetectable without a row-for-row parity check between the two paths.

**How to apply:** When adding a "complete" or "export" variant of a paged/bounded query, extract the shared filter+join+classify logic into one function and call it from both the bounded (LIMIT/OFFSET) and complete (unbounded) code paths. Add an automated test that runs both paths with identical filters — including a case where an admin/config-driven overlay affects the data — and asserts the returned record sets are identical by id/value/unit/quality, not just equal in count.