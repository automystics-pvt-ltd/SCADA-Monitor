---
name: Complete report evidence presentation
description: How operational report tables stay responsive without silently omitting selected-period evidence.
---

Operational report tables may page their visible rows for responsiveness, but selected-period retrieval and every export must retain the complete source-backed evidence set.

**Why:** Historical telemetry can contain tens of thousands of records. Rendering all rows in one browser view blocks review, while truncating the data would undermine auditability and conceal evidence.

**How to apply:** Clearly show the visible record range and total in the table UI. Keep pagination as a presentation concern only; do not apply it to the report API data, report filters, source-quality/exclusion counts, or CSV/Excel/JSON/PDF exports.