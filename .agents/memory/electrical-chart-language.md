---
name: Electrical chart language
description: Operator-facing naming and metadata conventions for electrical evidence charts.
---

Electrical chart labels should translate source identifiers into readable names such as Line AB voltage, Line BC voltage, Line CA voltage, Phase A current, and Grid frequency. Keep source scope, time range, and data quality as separate visible metadata rather than compressing them into an ambiguous status phrase.

**Why:** Raw identifiers and compact labels made the comparison and trend cards difficult to interpret even when the underlying records were accurate.

**How to apply:** Preserve the original parameter in detailed evidence/tooltips, but use the friendly label in axes, headings, and summaries. Always distinguish Validated, Raw · scaling needed, and Awaiting data.