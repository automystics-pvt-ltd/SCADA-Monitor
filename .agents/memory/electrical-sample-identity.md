---
name: Electrical sample identity
description: Stable identity rules for merging persisted and live Modbus electrical samples.
---

Saved MQTT windows can contain multiple readings for the same source, parameter, and source timestamp because the broker's source clock is only second-granular. A source timestamp alone is therefore not a safe UI key or merge identity.

**Why:** Repeated identities produce duplicate React keys and unstable range changes when a saved backend window is shown beside the live stream.

**How to apply:** When merging or rendering electrical evidence, identify a sample by its Modbus parameter identity plus receipt time (or saved-capture fallback) and reported value. Preserve source time as operator-facing provenance, not as the unique identifier.