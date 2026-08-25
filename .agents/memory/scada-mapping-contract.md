---
name: SCADA mapping contract
description: The mapping fields the SCADA monitor needs to apply an approved overlay to live and saved source evidence.
---

An active mapping delivered to SCADA must include its identity, destination, label, source/display units, multiplier, offset, approval status, inverter identity, and revision. Identity fields alone are insufficient.

**Why:** The monitor reapplies the authoritative overlay to long-lived live rows and saved snapshots. Without the transform fields, it can identify a mapping but cannot reproduce the approved display value or its validity.

**How to apply:** Keep the SCADA mapping endpoint's serialized shape aligned with the overlay resolver. When changing the mapping schema, audit both server-side resolution and client-side retained/saved-evidence refresh paths; clear or revise both snake-case payload projections and camel-case saved projections.