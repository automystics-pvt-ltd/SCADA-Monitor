---
name: Telemetry mapping overlay refresh
description: Rules for safely applying and clearing Admin-owned semantic mapping metadata on retained SCADA rows.
---

Admin-derived mapping values are an overlay, not a source fact. Before applying the current mapping set, remove every prior mapping-derived field; remove an inverter identity or source unit only when the overlay itself injected it.

**Why:** A clear or remap must take effect immediately on retained, replayed, or otherwise non-new telemetry. Leaving an old semantic destination behind can route evidence after an administrator has revoked it.

**How to apply:** Keep explicit markers for every source field that an overlay injects. On each mapping refresh, strip mapping metadata and only marked injected fields, preserve original source fields and values, then resolve the current exact source mapping. Keep this operation idempotent.