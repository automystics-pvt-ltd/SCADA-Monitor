---
name: SCADA lifecycle enforcement
description: Operational access rules for archived and paused managed SCADA sites.
---

Archived sites must not appear in SCADA site selection, location context, or any scoped operational evidence path. Every telemetry, history, report, event, and stream request must name a site, including when legacy global access is enabled. Paused sites may remain identifiable to an assigned user, but their operational requests must be denied until reactivated.

**Why:** A global or unscoped evidence path can accidentally bypass lifecycle checks and reveal data from an archived or paused plant. Requiring a named site makes the shared active/activation gate authoritative.

**How to apply:** When adding a SCADA evidence route, require an explicit site scope and pass it through the shared site gate. Do not add global/unscoped fallback queries, replay streams, or location results that include archived sites.