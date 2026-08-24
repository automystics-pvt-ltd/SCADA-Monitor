---
name: Bounded report evidence queries
description: Correctness and performance rules for paged SCADA report previews.
---

Normal SCADA report previews must build page rows, totals, summaries, and bounded chart samples from the same database-filtered evidence relation before returning data to the client. Do not page independent source tables and merge their slices in application code.

**Why:** Independent table offsets create gaps, duplicates, and misleading cross-source totals; materializing all selected-period evidence in Node merely moves pagination to presentation and does not improve large-period latency.

**How to apply:** Keep screen review on a parameterized unified evidence query with deterministic ordering and SQL-level page/count/aggregate operations. Retain a separate, explicit complete-evidence path for audit exports, rather than letting preview pagination silently truncate exported records.