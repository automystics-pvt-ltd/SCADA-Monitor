---
name: SCADA telemetry freshness
description: Rules for separating current operational state from replayed, cached, demo, and raw telemetry evidence.
---

Replayed or cached MQTT/SSE payloads may populate raw traceability and historical views, but they must not reset current telemetry freshness or be presented as current operational KPIs. A successful scheduled snapshot is a fallback during live-data outages only while its capture time is within the 15-minute freshness window; older records remain historical evidence, not current fallback data. Demo and live telemetry must remain provenance-separated across mode changes.

**Why:** Reconnect history can contain older observations, demo sessions can leave client-side rows behind, and a server heartbeat can report a healthy producer before a newly opened browser has received a fresh payload. Treating any of those as current makes offline equipment look online; retaining an old snapshot as a live fallback also hides that the plant has not produced a recent record.

**How to apply:** Preserve the source observation timestamp, mark replayed stream events explicitly, declare client-visible live data only after a fresh operational payload is processed locally, and derive online/stale/offline from that evidence. Clear or provenance-filter live buffers on mode changes; use only a successful saved record captured within 15 minutes as fallback, label it with its actual saved time, and return to no-valid-data once it ages out.