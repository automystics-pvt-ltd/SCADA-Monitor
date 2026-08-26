---
name: Canonical telemetry source identity
description: Raw and discovered representations of the same MQTT/Modbus register must share one site-qualified identity, or saved snapshots silently duplicate/miscount registers.
---

## The rule

There is exactly one canonical identity format for a telemetry register across the whole system: `siteName|sourceName|normalizedName|address` (site-qualified). It is used by:
- Discovered parameters (device-parameter-discovery)
- Platform telemetry mappings (admin mapping table + `source_identity` column)
- The report SQL join formula (scada-report-query)

Any code path that builds a *raw* (non-discovered) parameter representation of the same register must produce this exact identity too — computed with the capture-time resolved site name, not left blank or replaced by an unrelated bookkeeping identity.

**Why:** a per-vendor calibration step (e.g. TRN246) can stamp its own convenience identity (`"trn246|ana|<param>|<address>"`) onto the raw parameter for its own internal bookkeeping. That format is *not* site-qualified and is never recomputed by the discovery path for the same signal, so the two representations of one physical register look like two different sources. The snapshot merge/dedup logic prioritizes any existing `sourceIdentity`/`source_identity` field it finds, so a mismatched identity silently defeats deduplication — inflating parameter counts and producing duplicate/conflicting saved records instead of one canonical row.

**How to apply:** when introducing any new raw-parameter ingestion or persistence path, don't invent an ad hoc identity string. Reuse the shared identity function (`canonicalTelemetrySourceIdentity` in `device-parameter-discovery.ts`, or an equivalent single source of truth if it moves) and pass the already-resolved capture-time site name. Stamp the resulting identity onto the raw parameter *only* at the point of persistence (e.g. right before writing to a snapshot buffer) — not by mutating the shared in-flight message object, since other consumers of that same object (e.g. legacy configured-site rehoming/report paths) may intentionally resolve site identity differently for their own purpose and would break if forced onto the capture-resolved site too early. Add a regression test that runs an unscoped payload and a vendor-calibrated payload through the real raw-parsing + discovery functions (not hand-built matching identities) and asserts they collapse to one canonical record.
