---
name: Live MQTT configuration applies
description: Safety invariants for applying administrator-staged MQTT broker settings without restarting the service.
---

The live MQTT consumer must treat a staged broker configuration as a candidate: preserve the last known working runtime, connect with workspace-secret credentials, and only promote the candidate after transport and topic subscription are confirmed. If confirmation fails, restore the previous runtime and leave the database configuration marked pending.

**Why:** An administrator needs a controlled apply path, but an unreachable broker or unauthorized topic must not silently take down telemetry or make a staged setting appear active.

**How to apply:** Keep all credential reads server-side from workspace environment secrets. Expose apply state and resulting connection state through the admin API, and make the UI poll those server-owned states rather than treating a successful button response as proof of a live subscription.