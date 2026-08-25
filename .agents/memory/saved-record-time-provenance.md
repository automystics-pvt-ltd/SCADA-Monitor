---
name: Saved record time provenance
description: Rules for distinguishing a snapshot's actual persisted capture from its scheduled collection window.
---

Saved dashboard labels and KPI provenance must use the backend-confirmed `capturedAt` time. Keep `scheduledFor` and the start/end window only as separately labeled schedule metadata.

**Why:** A scheduled collection slot and the actual successful capture can differ after latency or retry. Showing the slot as the save time would misstate when the evidence was actually persisted.

**How to apply:** When presenting a saved snapshot as an operational record, format `capturedAt`. Retain the window fields for audit context, but never substitute them for the capture timestamp in status cards, KPI detail text, or saved-data labels.