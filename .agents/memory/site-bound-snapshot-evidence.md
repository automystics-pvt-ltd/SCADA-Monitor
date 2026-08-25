---
name: Site-bound snapshot evidence
description: Saved SCADA snapshots must remain scoped to their active site through loading, refresh, and fallback display.
---

Saved snapshot evidence is site-scoped state, not a global fallback. Clear it before changing site context and only retain a response that belongs to the currently requested site.

**Why:** A newer timestamp from another plant is not fresher evidence for the selected plant; retaining it can present one site's telemetry under another site's dashboard.

**How to apply:** Any site switch, logout, scoped fetch failure, or empty latest-snapshot response must remove the previous site's snapshot state. Apply current telemetry mappings again whenever a retained snapshot is refreshed or mappings are cleared.