---
name: SCADA telemetry freshness
description: Rules for separating current operational state from replayed, cached, demo, and raw telemetry evidence.
---

Replayed, retained, or cached MQTT/SSE payloads may populate raw traceability and historical views, but they must not reset current telemetry freshness or be presented as current operational KPIs. Future-dated source clocks are invalid operational evidence even when a broker delivery is fresh. A successful scheduled snapshot is a fallback during live-data outages only while its capture time is within the 15-minute freshness window; older records remain historical evidence, not current fallback data. Demo and live telemetry must remain provenance-separated across mode changes.

**Why:** Brokers can resend retained publications after a subscription, reconnect history can contain older observations, demo sessions can leave client-side rows behind, and a source clock can be corrupt. Treating any of those as current makes offline equipment look online; retaining an old snapshot as a live fallback also hides that the plant has not produced a recent record.

**How to apply:** Preserve the source observation timestamp, mark replayed and retained stream events explicitly, and admit only direct non-retained messages with source times at or before the local evaluation time into operational calculations. Clear or provenance-filter live buffers on mode changes; use only a successful saved record captured within 15 minutes as fallback, label it with its actual saved time, and return to no-valid-data once it ages out.