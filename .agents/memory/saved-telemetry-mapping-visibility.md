---
name: Saved telemetry mapping visibility
description: Saved site mappings remain editable without current source evidence and must retain full source identity.
---

Saved telemetry mappings are configuration records, not telemetry. When current source evidence is absent, return a configuration-only row with explicit unavailable status and null values rather than stale or invented measurements. Match, aggregate, and render mapping rows by the full site, device, source identity, normalized parameter, and register identity.

**Why:** Operators need to edit durable mapping decisions during temporary MQTT outages, while source/register collisions must never cause one mapping to attach to another source's evidence.

**How to apply:** Preserve saved active mappings in the Admin workspace even without a live discovery row; mark the evidence unavailable. Use the full identity for aggregation, API matching, and UI list keys. Clearing only disables mapping behavior and must not delete discovered evidence.