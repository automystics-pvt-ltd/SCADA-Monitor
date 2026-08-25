---
name: Authoritative telemetry mapping lifecycle
description: Rules for keeping discovery queue state correct while administrators map or clear signals during MQTT ingestion.
---

Mapping configuration is authoritative. A semantic no-op must not mutate mapping, discovery, audit, cache, or broadcast state. Acquire the exact-identity transaction lock before reading existing configuration, then decide whether to no-op or revise it. Real map/clear operations must commit their exact-identity discovery-status transition and audit record atomically, then notify connected clients only after commit.

**Why:** MQTT deliveries and administrator changes can overlap. Persisting a status inferred from an older in-memory overlay can reintroduce a cleared mapping or hide a newly unmapped source from the review queue.

**How to apply:** Share a transaction-scoped exact-identity lock between mapping mutations and catalog writes, resolve mapping status against durable active configuration while holding it, preserve a newer mapping-change watermark during conflict updates, and backfill lifecycle status when adding the feature to an existing catalog. Always reapply current mapping overlays to retained, replayed, and saved evidence rather than trusting a projection stored in an older payload.