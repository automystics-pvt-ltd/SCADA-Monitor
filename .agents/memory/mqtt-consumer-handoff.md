---
name: MQTT consumer handoff
description: Shared MQTT lease behavior during API-process handoff.
---

An API restart can temporarily report MQTT as `standby` even when the broker configuration is valid, because the previous consumer retains the shared lease until its expiry window closes.

**Why:** Forcing a second consumer during the handoff can create duplicate delivery and corrupt the ordered SSE evidence model.

**How to apply:** Confirm the previous process is gone, wait through the lease window, then check whether the new owner reaches `subscribed`. Diagnose broker credentials, topic configuration, or upstream silence only after ownership has transferred.