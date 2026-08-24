---
name: SCADA telemetry freshness
description: Rules for separating current operational state from replayed, cached, demo, and raw telemetry evidence.
---

Replayed or cached MQTT/SSE payloads may populate raw traceability and historical views, but they must not reset current telemetry freshness or be presented as current operational KPIs. Demo and live telemetry must remain provenance-separated across mode changes.

**Why:** Reconnect history can contain older observations, and demo sessions can leave client-side rows behind; treating either as fresh live telemetry makes offline equipment look online and can mislead operators.

**How to apply:** Preserve the source observation timestamp, mark replayed stream events explicitly, derive online/stale/offline from that observation time, clear or provenance-filter telemetry on mode changes, and keep cached evidence visibly labeled when current data is unavailable.