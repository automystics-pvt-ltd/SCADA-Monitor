---
name: Live energy lane continuity
description: Rules for preserving actual live energy-counter history without mixing evidence between sites or overstating freshness.
---

Direct MQTT/SSE daily-energy samples must survive a reconnect or manual live refresh. Reset that buffered lane only when the authenticated site's scope changes. Recent direct samples may remain visible during a short freshness transition, but must be relabeled as last-live evidence rather than current streaming telemetry.

**Why:** Clearing the lane for a transport reconnect makes a working plant-energy trend appear to stop until the next counter publication. Keeping it across site changes risks mixing one plant's evidence into another.

**How to apply:** Scope the client energy buffer to the authenticated site, retain it across same-site connection recovery, and distinguish current live samples from recent last-live samples using the source receipt time. Do not synthesize energy samples from power values.