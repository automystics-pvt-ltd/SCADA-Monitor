---
name: Sort comparators must mirror display fallback chains
description: A sortable column whose displayed value uses a multi-source fallback (approved/reported value, then raw transport value, then raw field) silently fails to reorder rows if its sort comparator only reads the first source in that chain.
---

When a table column's displayed cell value is computed with a fallback chain (e.g. `approvedValue ?? rawTransportValue ?? rawField ?? placeholder`), the sort comparator for that same column must use the identical chain.

**Why:** If the comparator only reads the first source (e.g. an "approved/scaled" value) and that source is legitimately absent for some rows (common for alarm/status/code parameters that only ever have a raw transport value, never an approved display value), those rows all compare as empty strings. The sort click then appears to do nothing for that column — no console error, no obvious failure, and the row order silently doesn't change — while other columns with a single-source value (e.g. a timestamp) sort correctly. This makes it look like a targeted, mysterious per-column bug rather than a fallback-chain mismatch.

**How to apply:** When adding a sortable column that reuses an existing multi-source display helper, don't shortcut the comparator to `String(primarySourceFn(row) ?? '')`. Reuse the same `a ?? b ?? c` chain (or a shared helper) used to render the cell, so sorting and display can never disagree about a row's effective value. This surfaces most reliably by testing sort ascending/descending on a filtered subset that includes rows known to lack the primary value source.
